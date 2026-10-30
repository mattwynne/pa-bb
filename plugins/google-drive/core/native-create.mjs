// Durable single-use creation lifecycle shared by native Docs and Sheets.
// Recovery only reads. A reserved key never authorizes another write.
import { createHash } from 'node:crypto';
import { docsError, docsErrorMessage } from './docs-edit.mjs';
export const hash = text => createHash('sha256').update(text).digest('hex');
export const fileId = value => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);
export const creationKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const messages = {
  invalid_input: 'Use an explicit connected account, lowercase UUID v4 operationId, title and bounded initial content. Destination must be root or an explicit folder ID. See the native creation skill for content limits.',
  destination_rejected: 'Choose My Drive root or an owned, unshared My Drive folder. Shared, shared-drive, non-writable or unverified destinations are not supported. No file was created.',
  scope_required: 'Creation requires an existing owner-authorized Drive write grant (drive or drive.file). Read-only and Docs-only grants cannot create here. The owner may reconnect through supported Google Drive Settings with explicit write consent. Do not change credentials or scopes manually.',
  operation_conflict: 'This operationId belongs to a different account or request. Do not replace it to retry an uncertain creation; inspect the original operation first.',
  operation_unknown: 'No creation receipt exists for this account, file type and operationId. This does not establish whether a file exists elsewhere. Do not blindly recreate it.',
};
export function creationError(code) { return Object.assign(new Error(messages[code] || 'Native file creation is unavailable. Inspect the operation before retrying.'), { creationCode: code }); }
export function creationErrorMessage(error) { return messages[error?.creationCode] || (['unknown_account', 'authorization_failed'].includes(error?.docsCode) ? docsErrorMessage(error) : 'Native file creation or inspection is unavailable. Check account authorization and enabled Google APIs in Settings. If creation was already requested, inspect its operationId; never blindly retry.'); }
export const creationFailureCategory = error => Object.hasOwn(messages, error?.creationCode) ? error.creationCode : 'unknown';
export function validateTarget(args) {
  if (typeof args.account !== 'string' || !args.account.trim() || args.account.length > 320 || !creationKey(args.operationId)) throw creationError('invalid_input');
}
export const validTitle = value => typeof value === 'string' && value.trim() && value.length <= 255 && value.isWellFormed() && !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
async function destination(drive, record, folderId) {
  const folder = await drive.getFile(record, folderId);
  if (!fileId(folder.id) || folder.trashed !== false || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.capabilities?.canAddChildren !== true) throw creationError('destination_rejected');
  if (folderId !== 'root') {
    const meta = await drive.getSharingMetadata(record, folder.id);
    const permissions = await drive.listPermissions(record, folder.id);
    if (meta.id !== folder.id || meta.driveId || meta.shared !== false || meta.owners?.length !== 1 || meta.owners[0].me !== true
      || permissions.nextPageToken || !Array.isArray(permissions.permissions) || permissions.permissions.length !== 1
      || permissions.permissions[0].type !== 'user' || permissions.permissions[0].role !== 'owner'
      || permissions.permissions[0].emailAddress?.toLowerCase() !== record.email.toLowerCase()) throw creationError('destination_rejected');
  }
  return folder.id;
}
export function createNativeCreationService({ store, drive, creation, spec, diagnose = () => {} }) {
  const belongs = op => (op.kind || 'document') === spec.kind;
  async function account(args) {
    validateTarget(args);
    const record = await store.byEmail(args.account);
    if (!record) throw docsError('unknown_account');
    return record;
  }
  const resourceId = op => op[spec.idField];
  function result(op, outcome = op.outcome, receiptOnly = false) {
    const id = resourceId(op);
    return { operationId: op.operationId, outcome, receiptOnly, writeAttempted: op.outcome === 'reserved' ? 'unknown' : op.writeAttempted, retrySafe: false,
      ...(id ? { [spec.idField]: id, url: spec.url(id) } : {}),
      guidance: receiptOnly ? `Historical receipt only; no Google read or write. Use ${spec.statusTool} for fresh verification. Never generate a new key to bypass uncertainty.`
        : outcome === 'verified' ? spec.verifiedGuidance
        : outcome === 'not_created' ? 'No file was created by this operation. The key remains consumed. Resolve authorization or availability before requesting a new creation; do not automatically generate a replacement key.'
        : `Creation is not verified. A blank or populated file may exist. Use ${spec.statusTool} with the same account and operationId. Never replay creation or population automatically.` };
  }
  const save = op => store.updateCreation(op);
  async function verify(record, op) {
    if (!resourceId(op)) return false;
    const file = await drive.getFile(record, resourceId(op));
    return file.id === resourceId(op) && file.trashed === false && file.mimeType === spec.mimeType
      && file.parents?.length === 1 && file.parents[0] === op.destinationId && hash(file.name || '') === op.titleHash
      && await spec.verify(record, op);
  }
  async function inspect(args) {
    const record = await account(args);
    const op = await store.getCreation(args.operationId);
    if (!op || op.subject !== record.subject || !belongs(op)) throw creationError('operation_unknown');
    try {
      if (!resourceId(op)) {
        const page = await creation.find(record, op.operationId);
        if (page.incompleteSearch === true || page.nextPageToken || !Array.isArray(page.files) || page.files.length !== 1 || !fileId(page.files[0]?.id)) {
          diagnose(`${spec.stage}_lookup_uncertain`, null);
          return result(op, 'uncertain');
        }
        op[spec.idField] = page.files[0].id;
        op.writeAttempted = true;
      }
      op.outcome = await verify(record, op) ? 'verified' : 'incomplete';
      if (op.outcome === 'incomplete') diagnose(`${spec.stage}_status_mismatch`, docsError('unsupported_document'));
      await save(op);
      return result(op);
    } catch (error) {
      diagnose(`${spec.stage}_status`, error);
      return result(op, 'verification_unavailable');
    }
  }
  async function create(args, signal) {
    validateTarget(args);
    if (!fileId(args.folderId) || !validTitle(args.title)) throw creationError('invalid_input');
    spec.validate(args);
    const record = await account(args);
    const requestHash = hash(JSON.stringify(spec.request(args)));
    const existing = await store.getCreation(args.operationId);
    if (existing) {
      if (!belongs(existing) || existing.subject !== record.subject || existing.requestHash !== requestHash) throw creationError('operation_conflict');
      return result(existing, existing.outcome, true);
    }
    const destinationId = await destination(drive, record, args.folderId);
    const writer = await creation.prepare(record);
    signal?.throwIfAborted();
    const op = { operationId: args.operationId, kind: spec.kind, subject: record.subject, requestHash, destinationId,
      titleHash: hash(args.title), ...spec.expected(args), outcome: 'reserved', writeAttempted: false };
    if (!await store.reserveCreation(op)) {
      const current = await store.getCreation(op.operationId);
      if (!current || !belongs(current) || current.subject !== record.subject || current.requestHash !== requestHash) throw creationError('operation_conflict');
      return result(current, current.outcome, true);
    }
    let stage = 'reserve';
    try {
      op.writeAttempted = true;
      await save(op);
      stage = 'create';
      const created = await writer.create({ operationId: op.operationId, title: args.title, folderId: destinationId }, signal);
      if (!fileId(created?.id)) throw docsError('unsupported_document');
      op[spec.idField] = created.id;
      op.outcome = 'created';
      await save(op); // No population without durable known ID.
      stage = 'populate';
      await spec.populate(writer, record, op, args, signal);
      stage = 'verify';
      if (!await verify(record, op)) throw docsError('unsupported_document');
      op.outcome = 'verified';
      await save(op);
      return result(op);
    } catch (error) {
      diagnose(`${spec.stage}_${stage}`, error);
      op.outcome = resourceId(op) ? (stage === 'verify' ? 'verification_unavailable' : 'incomplete') : 'uncertain';
      if (stage === 'create' && error?.creationRejected === true) op.outcome = 'not_created';
      if (stage === 'reserve' || (stage === 'create' && error?.creationWriteAttempted === false)) { op.outcome = 'not_created'; op.writeAttempted = false; }
      try { await save(op); } catch (storageError) { diagnose(`${spec.stage}_receipt`, storageError); }
      return result(op);
    }
  }
  return { create, inspect };
}
