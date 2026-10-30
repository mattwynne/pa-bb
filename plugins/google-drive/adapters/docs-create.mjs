import { DOCS_BASE } from './docs-transport.mjs';
import { createNativeCreationAdapter } from './native-create.mjs';
export function createDocsCreationAdapter(options) {
  return createNativeCreationAdapter({ ...options, mimeType: 'application/vnd.google-apps.document', marker: 'paDocsCreation',
    population: ({ documentId, tabId, revisionId, text }) => ({
      url: `${DOCS_BASE}/${encodeURIComponent(documentId)}:batchUpdate`,
      body: { writeControl: { requiredRevisionId: revisionId }, requests: [{ insertText: { location: { index: 1, tabId }, text } }] },
    }),
  });
}
