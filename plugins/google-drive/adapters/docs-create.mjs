import { createDocsTransport, DOCS_BASE, rejection } from './docs-transport.mjs';
import { docsError } from '../core/docs-edit.mjs';
import { creationError } from '../core/docs-create.mjs';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const writePolicy = {
  scopes: ['drive', 'drive.file'].map(name => `https://www.googleapis.com/auth/${name}`),
  scopeError: () => creationError('scope_required'),
  beforeSubmissionFailure: error => Object.assign(error instanceof Error ? error : docsError('authorization_failed'), { creationWriteAttempted: false }),
  writeRejection(status) {
    const error = rejection(status);
    // Known rejection means no application. All other statuses are uncertain.
    if ([400, 401, 403, 404].includes(status)) error.creationRejected = true;
    return error;
  },
};
export function createDocsCreationAdapter({ verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  return {
    async prepare(record) {
      const post = await transport.prepareWrite(record, writePolicy);
      return {
        create({ title, folderId, operationId }, signal) {
          return post(`${DRIVE}?fields=id&supportsAllDrives=true`, {
            name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId], appProperties: { paDocsCreation: operationId },
          }, signal);
        },
        populate({ documentId, tabId, revisionId, text }, signal) {
          return post(`${DOCS_BASE}/${encodeURIComponent(documentId)}:batchUpdate`, {
            writeControl: { requiredRevisionId: revisionId }, requests: [{ insertText: { location: { index: 1, tabId }, text } }],
          }, signal);
        },
      };
    },
    async find(record, operationId) {
      // Only a validated local receipt key reaches this method. No content search.
      const url = new URL(DRIVE);
      url.search = new URLSearchParams({ q: `trashed = false and appProperties has { key='paDocsCreation' and value='${operationId}' }`,
        spaces: 'drive', corpora: 'user', pageSize: '2', fields: 'files(id),nextPageToken,incompleteSearch' }).toString();
      return transport.get(record, url);
    },
  };
}
