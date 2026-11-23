import { createInterface } from 'node:readline';

const secret = process.env.SYNTHETIC_YNAB_TOKEN;
const tools = ['ynab_list_plans', 'ynab_mock_write'].map(name => ({ name, inputSchema: { type: 'object' } }));
let attempted = false;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const send = result => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
  switch (method) {
    case 'initialize':
      send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-ynab', version: '1' } });
      break;
    case 'tools/list':
      send(params?.cursor ? { tools } : { tools: [], nextCursor: 'page-2' });
      break;
    case 'tools/call':
      if (attempted) throw new Error('Unexpected replay');
      attempted = true;
      if (params.name === 'ynab_mock_write' || process.env.REJECT_PLAN_READ === 'true') {
        console.error(secret);
        send({ content: [{ type: 'text', text: secret }], isError: true });
      } else {
        send({ content: [{ type: 'text', text: '[{"id":"fake","name":"Synthetic plan"}]' }] });
      }
      break;
    default:
      console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
  }
}
