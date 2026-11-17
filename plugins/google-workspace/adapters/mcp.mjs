import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Implements the core's MCP port. SDK/HTTP details stay outside the application.
export function createMcpAdapter({ endpoint, fetchImpl = fetch, closeRuntime = async () => {} }) {
  const clients = new Set();
  let closed = false;
  async function using(token, options, action) {
    options.signal?.throwIfAborted();
    if (closed) throw new Error('MCP connection closed');
    const url = await endpoint();
    options.signal?.throwIfAborted();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } }, onInsufficientScope: 'throw',
      fetch: (input, init) => fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(60_000), ...[init?.signal, options.signal].filter(Boolean)]) }),
    });
    const client = new Client({ name: 'bb-google-workspace', version: '0.1.0' });
    clients.add(client);
    try {
      await client.connect(transport, { timeout: 15_000, signal: options.signal });
      return await action(client);
    } finally { clients.delete(client); await client.close().catch(() => {}); }
  }
  return {
    listTools(token, options = {}) {
      return using(token, options, async client => {
        const tools = []; let cursor;
        for (let page = 0; page < 8; page++) {
          const result = await client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, { signal: options.signal });
          tools.push(...result.tools);
          if (tools.length > 256 || JSON.stringify(tools).length > 4 * 1024 * 1024) throw new Error('MCP catalogue too large');
          if (!result.nextCursor) return tools;
          if (result.nextCursor === cursor) throw new Error('Repeated MCP catalogue cursor');
          cursor = result.nextCursor;
        }
        throw new Error('MCP catalogue paging limit');
      });
    },
    callTool(token, call, options = {}) {
      // One execution, no retry policy. A failed write may already have happened.
      return using(token, options, client => client.callTool(call, { signal: options.signal, timeout: 60_000 }));
    },
    async close() {
      closed = true;
      await Promise.all([...clients].map(client => client.close().catch(() => {})));
      await closeRuntime();
    },
  };
}
