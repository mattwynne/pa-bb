// Disposable ACP agent that reads real send-time context and calls the real plugin tool.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

let mcp;
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

async function detailLink({ kind, source, id }) {
  const child = spawn(mcp.command, mcp.args, {
    env: { ...process.env, ...Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (method, params, id) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const receive = async id => {
    for (;;) {
      const line = await lines.next();
      if (line.done) throw new Error('Synthetic MCP client did not get a tool result');
      const message = JSON.parse(line.value);
      if (message.id !== id) continue;
      if (message.error) throw new Error(message.error.message);
      return message.result;
    }
  };
  try {
    send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gtd-review', version: '1' } }, 1);
    await receive(1);
    send('notifications/initialized');
    send('tools/call', { name: 'gtd_resolve_detail_link', arguments: { kind, source, id } }, 2);
    const result = await receive(2);
    if (result.isError) throw new Error('GTD link tool refused the synthetic reference');
    return JSON.parse(result.content[0].text);
  } finally { child.kill(); }
}

for await (const line of createInterface({ input: process.stdin })) {
  const { method, params, id } = JSON.parse(line);
  if (id === undefined) continue;
  try {
    let result = {};
    if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
    if (method === 'session/new') {
      mcp = params.mcpServers.find(server => server.name === 'bb-bridge');
      result = { sessionId: randomUUID() };
    }
    if (method === 'session/prompt') {
      const prompt = params.prompt.map(block => block.text ?? '').join('\n');
      const mention = /Selected GTD (?:project|Area) metadata[^\n]*kind "(project|area)"[^\n]*\n(\{[^\n]+\})/.exec(prompt);
      const text = mention
        ? await (async () => {
            const { source, id } = JSON.parse(mention[2]);
            const { title, href } = await detailLink({ kind: mention[1], source, id });
            return `[Open ${title} in GTD](${href})\n\nResolved ${source} / ${id}`;
          })()
        : 'Synthetic review ready.';
      write({ method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      result = { stopReason: 'end_turn' };
    }
    write({ id, result });
  } catch (error) {
    write({ id, error: { code: -32603, message: String(error) } });
  }
}
