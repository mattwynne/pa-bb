import { docsError } from '../core/docs-edit.mjs';
const BASE = 'https://docs.googleapis.com/v1/documents';
const MAX_BYTES = 1_048_576;
export const DOCS_WRITE_SCOPES = Object.freeze(['documents', 'drive.file', 'drive'].map(name => `https://www.googleapis.com/auth/${name}`));
async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw docsError('unsupported_document');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw docsError('unsupported_document');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function rejection(status, write = false) {
  // Docs uses 400 for a requiredRevisionId conflict AND other invalid requests.
  // Treat every write 400 as rejected without inventing a provider reason.
  const code = [401, 403, 404].includes(status) ? 'authorization_failed'
    : write && status === 400 ? 'write_rejected' : 'remote_unavailable';
  return Object.assign(docsError(code), { status });
}
export function createDocsAdapter({ verifiedAccess, fetchImpl = fetch }) {
  async function writeAccess(record) {
    const accessToken = await verifiedAccess(record);
    const response = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw rejection(response.status);
    const grant = await boundedJson(response);
    const scopes = new Set(String(grant.scope || '').split(/\s+/));
    if (!DOCS_WRITE_SCOPES.some(scope => scopes.has(scope))) throw docsError('scope_required');
    return accessToken;
  }
  return {
    async inspect(record, id) {
      const accessToken = await verifiedAccess(record);
      const url = new URL(`${BASE}/${encodeURIComponent(id)}`);
      url.searchParams.set('includeTabsContent', 'true');
      url.searchParams.set('suggestionsViewMode', 'SUGGESTIONS_INLINE');
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw rejection(response.status);
      return boundedJson(response);
    },
    async prepareWrite(record) {
      await writeAccess(record);
      return {
        async replace(proposal, signal) {
          // Re-verify identity/grant immediately before the single mutation;
          // owner approval can take long enough for an access token to expire.
          let accessToken;
          try { accessToken = await writeAccess(record); signal?.throwIfAborted(); }
          catch (error) { throw Object.assign(error instanceof Error ? error : docsError('remote_unavailable'), { docsWriteAttempted: false }); }
          const response = await fetchImpl(`${BASE}/${encodeURIComponent(proposal.documentId)}:batchUpdate`, {
            method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
            body: JSON.stringify({ writeControl: { requiredRevisionId: proposal.expectedRevisionId }, requests: [{ replaceAllText: {
              containsText: { text: proposal.oldText, matchCase: true, searchByRegex: false },
              replaceText: proposal.newText, tabsCriteria: { tabIds: [proposal.tabId] },
            } }] }),
          });
          // No mutation retry, including 401, transport, timeout and 5xx.
          if (!response.ok) throw rejection(response.status, true);
          return boundedJson(response);
        },
      };
    },
  };
}
