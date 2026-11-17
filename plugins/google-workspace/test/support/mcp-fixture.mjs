// Small, independently authored provider examples; not a second Google implementation.
export const tools = [
  { name: 'get_doc_content', description: 'Read a document', inputSchema: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'] }, annotations: { readOnlyHint: true } },
  { name: 'modify_doc_text', description: 'Edit a document', inputSchema: { type: 'object', properties: { document_id: { type: 'string' }, text: { type: 'string' } }, required: ['document_id', 'text'] } },
  { name: 'send_gmail_message', description: 'Send mail', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
];
export const richResult = { content: [{ type: 'text', text: 'Saved 😀' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { id: 'result-1' } };
export function googleRpc({ tools: catalogue = tools, handler = () => richResult, pageSize = 2 } = {}) {
  const requests = [];
  return {
    requests,
    async fetch(url, init = {}) {
      const headers = new Headers(init.headers);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (!init.body) return new Response(null, { status: 405 });
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), token: headers.get('authorization'), body });
      if (body.id === undefined) return new Response(null, { status: 202 });
      let result;
      switch (body.method) {
        case 'initialize': result = { protocolVersion: body.params.protocolVersion, serverInfo: { name: 'synthetic-workspace', version: '1' }, capabilities: { tools: {} } }; break;
        case 'tools/list': {
          const start = Number(body.params?.cursor || 0);
          result = { tools: catalogue.slice(start, start + pageSize), ...(start + pageSize < catalogue.length ? { nextCursor: String(start + pageSize) } : {}) };
          break;
        }
        case 'tools/call': result = await handler(body.params, headers.get('authorization')); break;
        default: throw new Error(`Unexpected synthetic request ${body.method}`);
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  };
}
