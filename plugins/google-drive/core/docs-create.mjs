import { inspectDocument, docsError } from './docs-edit.mjs';
import { createNativeCreationService, creationError, hash } from './native-create.mjs';
export { creationKey, creationError, creationErrorMessage, creationFailureCategory } from './native-create.mjs';
export const CREATE_TEXT_LIMIT = 40_000;
export function createDocsCreationService({ store, drive, docs, creation, assessment, diagnose }) {
  return createNativeCreationService({ store, drive, creation, assessment, diagnose, spec: {
    kind: 'document', idField: 'documentId', mimeType: 'application/vnd.google-apps.document', stage: 'docs_creation',
    statusTool: 'gdocs_creation_status', url: id => `https://docs.google.com/document/d/${id}/edit`,
    verifiedGuidance: 'Title, destination and all body text were read back exactly. Plain paragraphs use Google default styling; formatting and privacy are not independently certified. No sharing changes or invitations were made.',
    request: args => [args.folderId, args.title, args.text], // Retain pre-Sheets receipt identity.
    reviewContent: args => args.text,
    expected: args => ({ textHash: hash(args.text + '\n') }),
    validate(args) {
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > CREATE_TEXT_LIMIT || !args.text.isWellFormed()
        || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\uE000-\uF8FF\u2028\u2029]/u.test(args.text)) throw creationError('invalid_input');
    },
    async verify(record, op) {
      const snapshot = inspectDocument(await docs.inspect(record, op.documentId), op.documentId);
      return hash(snapshot.title) === op.titleHash && snapshot.tabs.length === 1 && hash(snapshot.tabs[0].text) === op.textHash;
    },
    async populate(writer, record, op, args, signal) {
      const blank = inspectDocument(await docs.inspect(record, op.documentId), op.documentId);
      if (blank.tabs.length !== 1 || blank.tabs[0].text !== '\n' || blank.title !== args.title) throw docsError('unsupported_document');
      signal?.throwIfAborted();
      await writer.populate({ documentId: op.documentId, tabId: blank.tabs[0].tabId, revisionId: blank.revisionId, text: args.text }, signal);
    },
  } });
}
