import { docsError, documentId } from '../core/docs-edit.mjs';
import { imageRequest, imageSchema } from '../core/docs-image.mjs';
import { formatRequests, formatSchema } from '../core/docs-format.mjs';
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
        insertImage(proposal, signal, beforeSubmission) {
          const parsed = imageSchema.safeParse(proposal);
          if (!parsed.success) throw Object.assign(docsError('invalid_input'), { docsWriteAttempted: false });
          const args = parsed.data;
          return post(`${DOCS_BASE}/${encodeURIComponent(documentId(args.document))}:batchUpdate`, {
            writeControl: { requiredRevisionId: args.expectedRevisionId }, requests: [imageRequest(args)],
          }, signal, { beforeSubmission });
        },
        format(proposal, signal, beforeSubmission) {
          const parsed = formatSchema.safeParse(proposal);
          if (!parsed.success) throw Object.assign(docsError('invalid_input'), { docsWriteAttempted: false });
          const args = parsed.data;
          return post(`${DOCS_BASE}/${encodeURIComponent(documentId(args.document))}:batchUpdate`, {
            writeControl: { requiredRevisionId: args.expectedRevisionId }, requests: formatRequests(args),
          }, signal, { beforeSubmission });
        },
        replace(proposal, signal, beforeSubmission) {
          return post(`${DOCS_BASE}/${encodeURIComponent(proposal.documentId)}:batchUpdate`, {
            writeControl: { requiredRevisionId: proposal.expectedRevisionId }, requests: [{ replaceAllText: {
              containsText: { text: proposal.oldText, matchCase: true, searchByRegex: false },
              replaceText: proposal.newText, tabsCriteria: { tabIds: [proposal.tabId] },
            } }],
          }, signal, { beforeSubmission });
        },
      };
    },
  };
}
