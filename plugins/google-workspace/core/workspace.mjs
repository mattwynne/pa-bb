import { createHash } from 'node:crypto';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const failure = (workspaceCategory, message) => Object.assign(new Error(message), { workspaceCategory });
function describe(tool) {
  if (!/^[a-zA-Z0-9_-]+$/.test(tool.name) || tool.inputSchema?.type !== 'object') throw new Error('Unsupported tool schema');
  const schema = structuredClone(tool.inputSchema);
  if (schema.properties?.account) throw new Error('Upstream tool already defines account');
  delete schema.properties?.user_google_email;
  schema.properties = { ...schema.properties, account: { type: 'string', minLength: 1, description: 'Email of the connected Google Workspace account.' } };
  schema.required = [...new Set([...(schema.required || []).filter(k => k !== 'user_google_email'), 'account'])];
  const hash = createHash('sha256').update(JSON.stringify(stable(schema))).digest('hex').slice(0, 8);
  return { upstream: tool.name, name: `gworkspace_${tool.name}_${hash}`, description: tool.description || tool.name, inputSchema: schema, annotations: tool.annotations };
}

// Core-owned ports: accounts.list/access and mcp.listTools/callTool/close.
// No SDK, HTTP, process, storage or Google document model belongs here.
export function createWorkspace({ accounts, mcp }) {
  let catalogue = [];
  return {
    tools: () => catalogue.map(t => describe(t)),
    clear() { catalogue = []; },
    async refresh() {
      catalogue = [];
      const list = await accounts.list();
      if (!list.length) return;
      const token = await accounts.access(list[0].email);
      const tools = await mcp.listTools(token);
      for (const tool of tools) describe(tool);
      if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('Duplicate upstream tool');
      catalogue = structuredClone(tools);
    },
    async call(name, input, options = {}) {
      const tool = catalogue.find(t => t.name === name || describe(t).name === name);
      if (!tool) throw failure('tool_unavailable', 'Workspace tool unavailable. Refresh the catalogue.');
      const record = (await accounts.list()).find(a => a.email.toLowerCase() === String(input.account).toLowerCase());
      if (!record) throw failure('account_missing', 'Unknown Workspace account. Check connected accounts.');
      const token = await accounts.access(record.email);
      const { account, user_google_email, ...args } = input;
      if (Object.hasOwn(tool.inputSchema.properties || {}, 'user_google_email')) args.user_google_email = record.email;
      return mcp.callTool(token, { name: tool.name, arguments: args }, options);
    },
    async close() { catalogue = []; await mcp.close(); },
  };
}
