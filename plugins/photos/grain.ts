import { Client, ProtocolError, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { PluginAgentToolContentPart } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { failure, PhotosError } from './errors.ts';

export const endpointSchema = z.string().trim().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
export const grainConfiguration = z.object({ endpoint: endpointSchema, token: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/) }).strict();
export type GrainConfiguration = z.infer<typeof grainConfiguration>;
type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
const networkLimit = 2 * 1024 * 1024;
const resultLimit = 512 * 1024;
const timeout = 25_000;

function checked(value: unknown, token: string) {
  const json = JSON.stringify(value);
  if (token && json.includes(token)) throw new PhotosError('grain_secrets');
  if (Buffer.byteLength(json) > resultLimit) throw new PhotosError('limit');
  return json;
}

function boundedBody(response: Response) {
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length;
      if (bytes > networkLimit) controller.error(new PhotosError('limit'));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
}

export function grainMcp(log: (message: string) => void, fetcher: FetchLike = fetch) {
  let active = false;
  let generation = new AbortController();

  async function run<T>(config: GrainConfiguration, stage: 'check' | 'catalog' | 'call', signal: AbortSignal | undefined,
    execute: (client: Client, catalog: Map<string, Tool>, signal: AbortSignal) => Promise<T>) {
    if (active) throw new PhotosError('busy');
    const operation = AbortSignal.any([generation.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    operation.throwIfAborted();
    const endpoint = new URL(config.endpoint);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined, redirect: 'error' },
      fetch: async (input, init) => {
        if (new URL(String(input)).href !== endpoint.href) throw new PhotosError('grain_transport');
        const response = await fetcher(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([operation, init.signal]) : operation });
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel().catch(() => {});
          // A stateless MCP server may refuse the optional GET/DELETE streams.
          if (status === 405 && (init?.method === 'GET' || init?.method === 'DELETE')) return new Response(null, { status });
          throw new PhotosError(status === 401 || status === 403 ? 'grain_auth' : 'grain_transport');
        }
        return boundedBody(response);
      },
    });
    const client = new Client({ name: 'bb-photos', version: '0.1.0' });
    active = true;
    let boundary = 'handshake';
    try {
      await client.connect(transport, { signal: operation, timeout });
      boundary = 'catalog';
      const catalog = new Map<string, Tool>();
      const cursors = new Set<string>();
      let bytes = 0;
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal: operation, timeout });
        bytes += Buffer.byteLength(checked(page.tools, config.token));
        if (bytes > resultLimit) throw new PhotosError('limit');
        for (const tool of page.tools) {
          if (catalog.has(tool.name)) throw new PhotosError('grain_protocol');
          catalog.set(tool.name, tool);
        }
        cursor = page.nextCursor;
        if (cursor) {
          if (cursors.size >= 15 || cursors.has(cursor)) throw new PhotosError('grain_protocol');
          cursors.add(cursor);
        }
      } while (cursor);
      if (!catalog.size) throw new PhotosError('grain_protocol');
      if (stage === 'call') boundary = 'tool_call';
      const value = await execute(client, catalog, operation);
      operation.throwIfAborted();
      return value;
    } catch (error) {
      const reason = operation.aborted ? operation.reason : error;
      const fallback = reason instanceof ProtocolError ? 'grain_protocol'
        : reason instanceof UnauthorizedError || (reason instanceof SdkHttpError && [401, 403].includes(reason.status)) ? 'grain_auth' : 'grain_transport';
      const reported = failure(reason, fallback);
      log(`Grain ${boundary} ${reported.category}`);
      throw reported;
    } finally {
      try {
        if (transport.sessionId && !operation.aborted) await transport.terminateSession();
      } catch { log('Grain session_cleanup grain_transport'); }
      try { await client.close(); }
      catch { log('Grain connection_cleanup grain_transport'); }
      finally { active = false; }
    }
  }

  return {
    invalidate() {
      generation.abort();
      generation = new AbortController();
    },
    async check(config: GrainConfiguration) {
      await run(config, 'check', undefined, async () => {});
    },
    list(config: GrainConfiguration, signal: AbortSignal) {
      return run(config, 'catalog', signal, async (_, catalog) => [{ type: 'text' as const, text: checked([...catalog.values()], config.token) }]);
    },
    call(config: GrainConfiguration, name: string, args: Record<string, unknown>, signal: AbortSignal) {
      return run(config, 'call', signal, async (client, catalog, operation) => {
        if (!catalog.has(name)) throw new PhotosError('grain_missing');
        checked(args, config.token);
        const result = await client.callTool({ name, arguments: args }, { signal: operation, timeout });
        if ('isError' in result && result.isError) throw new PhotosError('grain_tool');
        checked(result, config.token);
        const parts: PluginAgentToolContentPart[] = [];
        if ('content' in result) {
          for (const item of result.content) {
            if (item.type === 'text') parts.push({ type: 'text', text: item.text });
            else if (item.type === 'image' && /^image\/(?:jpeg|png|gif|webp)$/.test(item.mimeType)) parts.push({ type: 'image', data: item.data, mimeType: item.mimeType });
            else parts.push({ type: 'text', text: JSON.stringify(item) });
          }
        }
        if ('structuredContent' in result && result.structuredContent !== undefined) parts.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
        return parts.length ? parts : [{ type: 'text' as const, text: checked(result, config.token) }];
      });
    },
  };
}
