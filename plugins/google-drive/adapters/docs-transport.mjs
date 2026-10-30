// Adapter-private HTTP plumbing. Core services only receive the narrow
// inspect/replace/create/populate/sharing ports, never this general request helper.
import { docsError } from '../core/docs-edit.mjs';
export const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
// Editing, creation and sharing retain this conservative default. General
// read-only Docs requests select their own bounded allowance explicitly.
const MAX_BYTES = 1_048_576;
const tooLarge = () => Object.assign(docsError('unsupported_document'), { code: 'response_too_large' });
const requestSignal = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
export async function boundedJson(response, maxBytes = MAX_BYTES) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) throw docsError('unsupported_document');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function rejection(status, write = false) {
  // Docs uses 400 for a revision conflict AND other invalid requests. Editing
  // classifies this as write_rejected; creation keeps its own rejection policy.
  const code = [401, 403, 404].includes(status) ? 'authorization_failed'
    : write && status === 400 ? 'write_rejected' : 'remote_unavailable';
  return Object.assign(docsError(code), { status });
}
export function createDocsTransport({ verifiedAccess, fetchImpl = fetch }) {
  return {
    async get(record, url) {
      const token = await verifiedAccess(record);
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: requestSignal() });
      if (!response.ok) throw rejection(response.status);
      return boundedJson(response);
    },
    async prepareWrite(record, policy) {
      async function access() {
        const token = await verifiedAccess(record);
        const response = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', { method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token: token }), signal: requestSignal() });
        if (!response.ok) throw rejection(response.status);
        const granted = new Set(String((await boundedJson(response)).scope || '').split(/\s+/));
        if (!policy.scopes.some(scope => granted.has(scope))) throw policy.scopeError();
        return token;
      }
      await access();
      return async function post(url, body, signal, options = {}) {
        let token;
        // Recheck identity and grant before EVERY mutation, even after a long
        // owner review. Only pre-submission failures get a no-attempt marker.
        try { token = await access(); signal?.throwIfAborted(); }
        catch (error) { throw policy.beforeSubmissionFailure(error); }
        // Exactly one mutation request. No retries, including 401, timeout, transport,
        // 429, 5xx or an unreadable response after possible application.
        const response = await fetchImpl(url, { method: options.method || 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: requestSignal(signal) });
        if (!response.ok) throw policy.writeRejection(response.status);
        if (options.emptyResponse === true && response.status === 204) return {};
        return boundedJson(response);
      };
    },
  };
}
