import { createDocsTransport, rejection } from './docs-transport.mjs';
import { docsError } from '../core/docs-edit.mjs';
import { creationError } from '../core/native-create.mjs';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const writePolicy = {
  scopes: ['drive', 'drive.file'].map(name => `https://www.googleapis.com/auth/${name}`),
  scopeError: () => creationError('scope_required'),
  beforeSubmissionFailure: error => Object.assign(error instanceof Error ? error : docsError('authorization_failed'), { creationWriteAttempted: false }),
  writeRejection(status) {
    const error = rejection(status);
    if ([400, 401, 403, 404].includes(status)) error.creationRejected = true;
    return error;
  },
};
// Only adapter-owned constants and narrow population builders reach this helper.
export function createNativeCreationAdapter({ verifiedAccess, fetchImpl = fetch, mimeType, marker, population }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  return {
    async prepare(record) {
      const post = await transport.prepareWrite(record, writePolicy);
      return {
        create({ title, folderId, operationId }, signal) {
          return post(`${DRIVE}?fields=id&supportsAllDrives=true`, {
            name: title, mimeType, parents: [folderId], appProperties: { [marker]: operationId },
          }, signal);
        },
        populate(input, signal) {
          const { url, body } = population(input);
          return post(url, body, signal);
        },
      };
    },
    async find(record, operationId) {
      const url = new URL(DRIVE);
      url.search = new URLSearchParams({ q: `trashed = false and appProperties has { key='${marker}' and value='${operationId}' }`,
        spaces: 'drive', corpora: 'user', pageSize: '2', fields: 'files(id),nextPageToken,incompleteSearch' }).toString();
      return transport.get(record, url);
    },
  };
}
