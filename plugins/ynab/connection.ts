import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client, ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const require = createRequire(import.meta.url);
const timeout = 20_000;
const outputLimit = 256 * 1024;
const planTool = 'ynab_list_plans';
type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type Configuration = { token?: string; allowWrites: boolean };
type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function startTransport(token: string, allowWrites: boolean) {
  const manifest = require.resolve('ynab-mcp-server/package.json');
  return new StdioClientTransport({
    command: process.execPath,
    args: [join(dirname(manifest), 'dist/index.js')],
    env: {
      YNAB_API_TOKEN: token,
      YNAB_READ_ONLY: allowWrites ? 'false' : 'true',
      YNAB_AI_CATEGORIZATION: 'false',
    },
    stderr: 'ignore',
    maxBufferSize: 1024 * 1024,
  });
}

class Failure extends Error {
  readonly category: string;

  constructor(category: string, message: string) {
    super(message);
    this.category = category;
  }
}

function category(error: unknown) {
  if (error instanceof Failure) return error.category;
  if (error instanceof ProtocolError) return 'protocol_error';
  if (error instanceof SdkError && Object.values(SdkErrorCode).some(code => code === error.code)) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timed_out';
  return 'unknown';
}

function planResponse(result: ToolResult): boolean {
  if (!('content' in result) || result.content.length !== 1 || result.content[0]?.type !== 'text') return false;
  const text = result.content[0].text;
  if (Buffer.byteLength(text) > outputLimit) return false;
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

export function createConnection(
  initial: Configuration,
  log: (message: string) => void,
  transport: typeof startTransport = startTransport,
) {
  let configuration = initial;
  let lifetime = new AbortController();
  let disposed = false;
  let active: Promise<unknown> | undefined;

  async function run<T>(
    action: 'catalog' | 'plan_check' | 'tool_call',
    signal: AbortSignal | undefined,
    execute: (client: Client, operation: AbortSignal, token: string, setStage: (value: 'tool_call') => void) => Promise<T>,
  ): Promise<T> {
    if (active) throw new Error('YNAB is busy. Try again when the current operation finishes.');
    if (disposed) throw new Error('The YNAB plugin stopped. Try again after it reloads.');
    const operation = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const { token, allowWrites } = configuration;
    const work = Promise.resolve().then(async () => {
      let stage = 'connection_start';
      let client: Client | undefined;
      try {
        operation.throwIfAborted();
        if (!token) throw new Failure('unconfigured', 'Add a YNAB personal access token in the plugin’s BB settings.');
        client = new Client({ name: 'bb-ynab', version: '0.1.0' });
        await client.connect(transport(token, allowWrites), { signal: operation, timeout });
        stage = action === 'tool_call' ? 'catalog' : action;
        return await execute(client, operation, token, value => { stage = value; });
      } catch (error) {
        log(`YNAB ${stage} ${category(error)}`);
        if (error instanceof Failure) throw new Error(error.message);
        if (stage === 'tool_call') throw new Error('YNAB did not confirm the result. Check your plan before retrying a change.');
        if (stage === 'connection_start') throw new Error('BB could not start the YNAB MCP server. Check the plugin logs.');
        throw new Error('YNAB did not complete the read. Check the plugin logs and your YNAB token.');
      } finally {
        try { await client?.close(); }
        catch (error) { log(`YNAB connection_cleanup ${category(error)}`); }
      }
    });
    active = work;
    try { return await work; }
    finally { active = undefined; }
  }

  async function catalog(client: Client, signal: AbortSignal) {
    const tools = new Map<string, Tool>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout });
      if (cursor) cursors.add(cursor);
      cursor = page.nextCursor;
      bytes += Buffer.byteLength(JSON.stringify(page.tools));
      if (bytes > outputLimit || cursors.size >= 16 || (cursor && cursors.has(cursor))) {
        throw new Failure('catalog_limit', 'YNAB returned a tool catalog that BB could not read completely.');
      }
      for (const tool of page.tools) {
        if (tools.has(tool.name)) throw new Failure('duplicate_tool', 'YNAB returned duplicate tool names.');
        tools.set(tool.name, tool);
      }
    } while (cursor);
    return tools;
  }

  async function invoke(client: Client, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    return client.callTool({ name, arguments: args }, { signal, timeout });
  }

  function boundedOutput(value: unknown, token: string) {
    const output = JSON.stringify(value);
    if (output.includes(token)) throw new Failure('credential_in_response', 'YNAB returned a response that BB could not display safely.');
    if (Buffer.byteLength(output) > outputLimit) {
      throw new Failure('result_limit', 'YNAB returned more data than BB can display. Use narrower filters for reads and check your plan before retrying changes.');
    }
    return output;
  }

  return {
    get configured() { return Boolean(configuration.token); },
    configure(next: Configuration) {
      lifetime.abort();
      lifetime = new AbortController();
      configuration = next;
    },
    check(signal?: AbortSignal) {
      return run('plan_check', signal, async (client, operation) => {
        const result = await invoke(client, planTool, {}, operation);
        if ('isError' in result && result.isError) {
          throw new Failure('provider_error_result', 'YNAB rejected the plan read. Check the personal access token in BB settings and try again.');
        }
        if (!planResponse(result)) throw new Failure('unexpected_plan_result', 'YNAB returned an unexpected response to the plan read.');
      });
    },
    list(signal?: AbortSignal) {
      return run('catalog', signal, async (client, operation, token) =>
        boundedOutput([...(await catalog(client, operation)).values()], token));
    },
    call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      return run('tool_call', signal, async (client, operation, token, setStage) => {
        const tools = await catalog(client, operation);
        if (!tools.has(name)) throw new Failure('tool_unavailable', 'This tool is unavailable in the current YNAB configuration. Refresh the tool list.');
        setStage('tool_call');
        const result = await invoke(client, name, args, operation);
        if ('isError' in result && result.isError) {
          throw new Failure('provider_error_result', 'YNAB reported an error. Check your plan before retrying a change.');
        }
        return boundedOutput(result, token);
      });
    },
    async dispose() {
      disposed = true;
      lifetime.abort();
      await active?.catch(() => {});
    },
  };
}
