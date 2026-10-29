// A creation key is a durable, single-use reservation, not a retry token.
// Recovery only reads Google. It never creates, populates, deletes or shares.
import { createHash } from 'node:crypto';
import { inspectDocument, docsError, docsErrorMessage } from './docs-edit.mjs';
export const CREATE_TEXT_LIMIT = 40_000;
const DOCUMENT = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';
const hash = text => createHash('sha256').update(text).digest('hex');
const id = value => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);
export const creationKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const messages = {
  invalid_input: 'Use an explicit connected account, lowercase UUID v4 operationId, folderId (root or a folder ID), title (1–255 characters), and plain text (1–40000 UTF-16 units). Use LF paragraph breaks; no unsupported control characters.',
  destination_rejected: 'Choose My Drive root or an owned, unshared My Drive folder. Shared, shared-drive, non-writable or unverified destinations are not supported. No document was created.',
  scope_required: 'Creation requires an existing owner-authorized Drive write grant (drive or drive.file). Read-only and Docs-only grants cannot create here. The owner may reconnect through supported Google Drive Settings with explicit write consent. Do not change credentials or scopes manually.',
  operation_conflict: 'This operationId belongs to a different account or request. Do not replace it to retry an uncertain creation; inspect the original operation first.',
  operation_unknown: 'No creation receipt exists for this account and operationId. This does not establish whether a document exists elsewhere. Do not blindly recreate it.',
};
export function creationError(code) { return Object.assign(new Error(messages[code] || 'Google document creation is unavailable. Inspect the operation before retrying.'), { creationCode: code }); }
export function creationErrorMessage(error) { return messages[error?.creationCode] || (['unknown_account', 'authorization_failed'].includes(error?.docsCode) ? docsErrorMessage(error) : 'Google document creation or inspection is unavailable. Check account authorization in Settings. If creation was already requested, inspect its operationId; never blindly retry.'); }
export const creationFailureCategory = error => Object.hasOwn(messages, error?.creationCode) ? error.creationCode : 'unknown';
function validate(args) {
  if (typeof args.account !== 'string' || !args.account.trim() || args.account.length > 320 || !creationKey(args.operationId)) throw creationError('invalid_input');
}
function validateCreate(args) {
  validate(args);
  if (!id(args.folderId) || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 255 || !args.title.isWellFormed() || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(args.title)
    || typeof args.text !== 'string' || !args.text.trim() || args.text.length > CREATE_TEXT_LIMIT || !args.text.isWellFormed()
    || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\uE000-\uF8FF\u2028\u2029]/u.test(args.text)) throw creationError('invalid_input');
}
export function createDocsCreationService({ store, drive, docs, creation, diagnose = (_stage, _error) => {} }) {
  async function account(args) {
    validate(args);
    const record = await store.byEmail(args.account);
    if (!record) throw docsError('unknown_account');
    return record;
  }
  function result(op, outcome = op.outcome, receiptOnly = false) {
    return { operationId: op.operationId, outcome, receiptOnly, writeAttempted: op.outcome === 'reserved' ? 'unknown' : op.writeAttempted, retrySafe: false,
      ...(op.documentId ? { documentId: op.documentId, url: `https://docs.google.com/document/d/${op.documentId}/edit` } : {}),
      guidance: receiptOnly ? 'Historical operation receipt only; this call did not write or read Google. Use gdocs_creation_status for fresh verification. Never generate a new key to bypass an uncertain result.'
        : outcome === 'verified' ? 'Title, destination and all body text were read back exactly. Plain paragraphs use Google default styling; formatting and privacy are not independently certified. No sharing changes or invitations were made.'
        : outcome === 'not_created' ? 'No document was created by this operation. The key remains consumed. Resolve authorization or availability before requesting a new creation; do not automatically generate a replacement key.'
        : 'Creation is not verified. A blank or populated document may exist. Use gdocs_creation_status with this account and operationId, or inspect the returned link. Never replay creation or population automatically.' };
  }
  async function save(op) { await store.updateCreation(op); }
  async function verify(record, op) {
    if (!op.documentId) return false;
    const file = await drive.getFile(record, op.documentId);
    const snapshot = inspectDocument(await docs.inspect(record, op.documentId), op.documentId);
    return file.id === op.documentId && file.trashed === false && file.mimeType === DOCUMENT && file.parents?.length === 1 && file.parents[0] === op.destinationId
      && hash(file.name || '') === op.titleHash && hash(snapshot.title) === op.titleHash && snapshot.tabs.length === 1 && hash(snapshot.tabs[0].text) === op.textHash;
  }
  async function inspect(args) {
    const record = await account(args);
    const op = await store.getCreation(args.operationId);
    if (!op || op.subject !== record.subject) throw creationError('operation_unknown');
    try {
      if (!op.documentId) {
        const page = await creation.find(record, op.operationId);
        if (page.incompleteSearch === true || page.nextPageToken || !Array.isArray(page.files) || page.files.length !== 1 || !id(page.files[0]?.id)) {
          diagnose('docs_creation_lookup_uncertain', null);
          return result(op, 'uncertain');
        }
        op.documentId = page.files[0].id;
        op.writeAttempted = true;
      }
      op.outcome = await verify(record, op) ? 'verified' : 'incomplete';
      if (op.outcome === 'incomplete') diagnose('docs_creation_status_mismatch', docsError('unsupported_document'));
      await save(op);
      return result(op);
    } catch (error) {
      diagnose('docs_creation_status', error);
      return result(op, 'verification_unavailable');
    }
  }
  async function destination(record, folderId) {
    const folder = await drive.getFile(record, folderId);
    if (!id(folder.id) || folder.trashed !== false || folder.mimeType !== FOLDER || folder.capabilities?.canAddChildren !== true) throw creationError('destination_rejected');
    if (folderId !== 'root') {
      // Conservative policy: no opt-in escape hatch for inherited audiences.
      // These provider checks are not a general proof of privacy.
      const meta = await drive.getSharingMetadata(record, folder.id);
      const permissions = await drive.listPermissions(record, folder.id);
      if (meta.id !== folder.id || meta.driveId || meta.shared !== false || meta.owners?.length !== 1 || meta.owners[0].me !== true
        || permissions.nextPageToken || !Array.isArray(permissions.permissions) || permissions.permissions.length !== 1
        || permissions.permissions[0].type !== 'user' || permissions.permissions[0].role !== 'owner'
        || permissions.permissions[0].emailAddress?.toLowerCase() !== record.email.toLowerCase()) throw creationError('destination_rejected');
    }
    return folder.id;
  }
  async function create(args, signal) {
    validateCreate(args);
    const record = await account(args);
    const requestHash = hash(JSON.stringify([args.folderId, args.title, args.text]));
    const existing = await store.getCreation(args.operationId);
    if (existing) {
      if (existing.subject !== record.subject || existing.requestHash !== requestHash) throw creationError('operation_conflict');
      // Including concurrent/repeated calls: return only the saved receipt.
      // A status read may run while the first operation is still in progress.
      return result(existing, existing.outcome, true);
    }
    const destinationId = await destination(record, args.folderId);
    const writer = await creation.prepare(record);
    signal?.throwIfAborted();
    const op = { operationId: args.operationId, subject: record.subject, requestHash, destinationId,
      titleHash: hash(args.title), textHash: hash(args.text + '\n'), outcome: 'reserved', writeAttempted: false };
    if (!await store.reserveCreation(op)) {
      const current = await store.getCreation(op.operationId);
      if (!current || current.subject !== record.subject || current.requestHash !== requestHash) throw creationError('operation_conflict');
      return result(current, current.outcome, true);
    }
    let stage = 'reserve';
    try {
      // Reserve durably before submitting a non-idempotent POST. Even a crash
      // here consumes the key; read-only recovery can look up appProperties.
      op.writeAttempted = true;
      await save(op);
      stage = 'create';
      const created = await writer.create({ operationId: op.operationId, title: args.title, folderId: destinationId }, signal);
      if (!id(created?.id)) throw docsError('unsupported_document');
      op.documentId = created.id;
      op.outcome = 'created';
      await save(op); // Never populate without durably saving the known ID.
      stage = 'populate';
      const blank = inspectDocument(await docs.inspect(record, op.documentId), op.documentId);
      if (blank.tabs.length !== 1 || blank.tabs[0].text !== '\n' || blank.title !== args.title) throw docsError('unsupported_document');
      signal?.throwIfAborted();
      await writer.populate({ documentId: op.documentId, tabId: blank.tabs[0].tabId, revisionId: blank.revisionId, text: args.text }, signal);
      stage = 'verify';
      if (!await verify(record, op)) throw docsError('unsupported_document');
      op.outcome = 'verified';
      await save(op);
      return result(op);
    } catch (error) {
      diagnose(`docs_creation_${stage}`, error);
      op.outcome = op.documentId ? (stage === 'verify' ? 'verification_unavailable' : 'incomplete') : 'uncertain';
      if (stage === 'create' && error?.creationRejected === true) op.outcome = 'not_created';
      if (stage === 'reserve' || (stage === 'create' && error?.creationWriteAttempted === false)) { op.outcome = 'not_created'; op.writeAttempted = false; }
      try { await save(op); } catch (storageError) { diagnose('docs_creation_receipt', storageError); }
      return result(op);
    }
  }
  return { create, inspect };
}
