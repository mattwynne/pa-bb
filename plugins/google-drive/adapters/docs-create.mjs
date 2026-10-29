import { boundedJson } from './docs.mjs';
import { docsError } from '../core/docs-edit.mjs';
import { creationError } from '../core/docs-create.mjs';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const scopes = ['drive', 'drive.file'].map(name => `https://www.googleapis.com/auth/${name}`);
const timeout = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
function rejected(status) { return Object.assign(docsError([401, 403, 404].includes(status) ? 'authorization_failed' : 'remote_unavailable'), { status }); }
export function createDocsCreationAdapter({ verifiedAccess, fetchImpl = fetch }) {
  async function access(record) {
    const token = await verifiedAccess(record);
    const response = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token: token }), signal: timeout() });
    if (!response.ok) throw rejected(response.status);
    const granted = new Set(String((await boundedJson(response)).scope || '').split(/\s+/));
    if (!scopes.some(scope => granted.has(scope))) throw creationError('scope_required');
    return token;
  }
  async function post(record, url, body, signal) {
    let token;
    try { token = await access(record); signal?.throwIfAborted(); }
    catch (error) { throw Object.assign(error instanceof Error ? error : docsError('authorization_failed'), { creationWriteAttempted: false }); }
    // Exactly one POST; no retry on 401, timeout, transport, 429 or 5xx.
    const response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: timeout(signal) });
    if (!response.ok) {
      const error = rejected(response.status);
      // Known rejection means no application. All other statuses are uncertain.
      if ([400, 401, 403, 404].includes(response.status)) error.creationRejected = true;
      throw error;
    }
    return boundedJson(response);
  }
  return {
    async prepare(record) {
      await access(record);
      return {
        create({ title, folderId, operationId }, signal) {
          return post(record, `${DRIVE}?fields=id&supportsAllDrives=true`, {
            name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId], appProperties: { paDocsCreation: operationId },
          }, signal);
        },
        populate({ documentId, tabId, revisionId, text }, signal) {
          return post(record, `${DOCS}/${encodeURIComponent(documentId)}:batchUpdate`, {
            writeControl: { requiredRevisionId: revisionId }, requests: [{ insertText: { location: { index: 1, tabId }, text } }],
          }, signal);
        },
      };
    },
    async find(record, operationId) {
      // Only a validated local receipt key reaches this method. No content search.
      const token = await verifiedAccess(record);
      const url = new URL(DRIVE);
      url.search = new URLSearchParams({ q: `trashed = false and appProperties has { key='paDocsCreation' and value='${operationId}' }`,
        spaces: 'drive', corpora: 'user', pageSize: '2', fields: 'files(id),nextPageToken,incompleteSearch' }).toString();
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: timeout() });
      if (!response.ok) throw rejected(response.status);
      return boundedJson(response);
    },
  };
}
