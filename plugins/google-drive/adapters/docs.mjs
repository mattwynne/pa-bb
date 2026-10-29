import { docsError } from '../core/docs-edit.mjs';
import { createDocsTransport, DOCS_BASE, rejection } from './docs-transport.mjs';
export const DOCS_WRITE_SCOPES = Object.freeze(['documents', 'drive.file', 'drive'].map(name => `https://www.googleapis.com/auth/${name}`));
const writePolicy = {
  scopes: DOCS_WRITE_SCOPES,
  scopeError: () => docsError('scope_required'),
  beforeSubmissionFailure: error => Object.assign(error instanceof Error ? error : docsError('remote_unavailable'), { docsWriteAttempted: false }),
  writeRejection: status => rejection(status, true),
};
export function createDocsAdapter({ verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  return {
    inspect(record, id) {
      const url = new URL(`${DOCS_BASE}/${encodeURIComponent(id)}`);
      url.searchParams.set('includeTabsContent', 'true');
      url.searchParams.set('suggestionsViewMode', 'SUGGESTIONS_INLINE');
      return transport.get(record, url);
    },
    async prepareWrite(record) {
      const post = await transport.prepareWrite(record, writePolicy);
      return {
        replace(proposal, signal) {
          return post(`${DOCS_BASE}/${encodeURIComponent(proposal.documentId)}:batchUpdate`, {
            writeControl: { requiredRevisionId: proposal.expectedRevisionId }, requests: [{ replaceAllText: {
              containsText: { text: proposal.oldText, matchCase: true, searchByRegex: false },
              replaceText: proposal.newText, tabsCriteria: { tabIds: [proposal.tabId] },
            } }],
          }, signal);
        },
      };
    },
  };
}
