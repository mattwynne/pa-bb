import { creationKey, fileId, hash } from './native-create.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const fail = code => Object.assign(new Error('Copy is unavailable.'), { copyCode: code });
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && value.isWellFormed();

// Shares the durable creation reservation store, not the native population workflow.
export function createCopyService({ store, drive, fileInfo, diagnose = () => {} }) {
  const active = new Set();
  async function account(args) {
    if (typeof args.account !== 'string' || !args.account.trim() || args.account.length > 320 || !creationKey(args.operationId)) throw fail('invalid');
    const record = await store.byEmail(args.account);
    if (!record) throw fail('account');
    return record;
  }
  function receipt(op, extra = {}) {
    return { account: extra.account, operationId: op.operationId, outcome: op.outcome, retrySafe: false,
      writeAttempted: op.outcome === 'reserved' ? 'unknown' : op.writeAttempted,
      acknowledged: op.acknowledged === true,
      ...(op.fileId ? { file: fileInfo({ id: op.fileId, mimeType: op.mimeType }) } : {}),
      guidance: 'Keep this operationId. Use gdrive_copy_status for read-only recovery; never replay or replace a key to bypass uncertainty. Metadata verification does not establish content equality or privacy.', ...extra };
  }
  async function verify(record, op, id) {
    const file = await drive.getFile(record, id);
    const matches = file.id === id && file.trashed === false && file.mimeType === op.mimeType &&
      Array.isArray(file.parents) && file.parents.length === 1 && file.parents[0] === op.destinationId &&
      typeof file.name === 'string' && hash(file.name) === op.titleHash && file.appProperties?.paCopyCreation === op.operationId;
    return { matches, file };
  }
  async function copy(args) {
    const record = await account(args);
    if (!fileId(args.sourceId) || !fileId(args.folderId) || (args.title !== undefined && !validText(args.title))) throw fail('invalid');
    const title = args.title === undefined ? undefined : args.title.trim();
    const requestHash = hash(JSON.stringify(['copy', args.sourceId, args.folderId, title ?? null]));
    const existing = await store.getCreation(args.operationId);
    if (existing) {
      if (existing.kind !== 'copy' || existing.subject !== record.subject || existing.requestHash !== requestHash) throw fail('conflict');
      return receipt(existing, { account: record.email, receiptOnly: true });
    }
    const source = await drive.getFile(record, args.sourceId);
    const destination = await drive.getFile(record, args.folderId);
    if (source.id !== args.sourceId || source.trashed !== false || source.mimeType === FOLDER || source.mimeType === SHORTCUT || source.capabilities?.canCopy !== true || !validText(source.mimeType)) throw fail('source');
    if ((args.folderId !== 'root' && destination.id !== args.folderId) || destination.trashed !== false || destination.mimeType !== FOLDER || destination.capabilities?.canAddChildren !== true || !fileId(destination.id)) throw fail('destination');
    const resolvedTitle = title ?? source.name;
    if (!validText(resolvedTitle)) throw fail('source');
    const writer = await drive.prepareCopy(record);
    const op = { operationId: args.operationId, kind: 'copy', subject: record.subject, requestHash,
      destinationId: destination.id, driveId: fileId(destination.driveId) ? destination.driveId : null,
      titleHash: hash(resolvedTitle), mimeType: source.mimeType, outcome: 'reserved', writeAttempted: false, acknowledged: false };
    if (!await store.reserveCreation(op)) {
      const current = await store.getCreation(op.operationId);
      if (!current || current.kind !== 'copy' || current.subject !== record.subject || current.requestHash !== requestHash) throw fail('conflict');
      return receipt(current, { account: record.email, receiptOnly: true });
    }
    active.add(op.operationId);
    try {
      // A crash after this durable transition is always treated as uncertain.
      op.outcome = 'uncertain'; op.writeAttempted = true;
      await store.updateCreation(op);
      const result = await writer(args.sourceId, destination.id, resolvedTitle, op.operationId);
      if (result.failure === 'transport') diagnose('copy_submission_transport', null);
      else if (result.failure === 'invalid_response') diagnose('copy_submission_invalid_response', null);
      else if (result.failure === 'oversized') diagnose('copy_submission_oversized', { code: 'response_too_large' });
      else if (result.failure === 'http') diagnose('copy_submission_http', { status: result.status });
      if (result.notCreated) { op.outcome = 'not_created'; await store.updateCreation(op); return receipt(op, { account: record.email }); }
      if (!fileId(result.id)) { if (!result.failure) diagnose('copy_submission_invalid_id', null); return receipt(op, { account: record.email }); }
      op.fileId = result.id; op.acknowledged = true;
      // Never verify before the acknowledged ID is durable.
      await store.updateCreation(op);
      const observed = await verify(record, op, op.fileId);
      if (!observed.matches) diagnose('copy_verification_mismatch', null);
      op.outcome = observed.matches ? 'verified' : 'mismatch';
      await store.updateCreation(op);
      return receipt(op, { account: record.email, ...(observed.matches ? { file: fileInfo(observed.file) } : {}) });
    } catch (error) {
      diagnose('copy_write_or_verification', error);
      // A failed receipt update must not trigger a second provider write. In-memory
      // evidence may be returned, but the durable receipt controls recovery.
      return receipt(op, { account: record.email, outcome: op.acknowledged ? 'verification_unavailable' : 'uncertain' });
    } finally { active.delete(op.operationId); }
  }
  async function status(args) {
    const record = await account(args);
    const op = await store.getCreation(args.operationId);
    if (!op || op.kind !== 'copy' || op.subject !== record.subject) throw fail('unknown');
    if (active.has(op.operationId)) return receipt(op, { account: record.email, inProgress: true });
    if (op.outcome === 'not_created') return receipt(op, { account: record.email, receiptOnly: true });
    try {
      if (op.acknowledged && fileId(op.fileId)) {
        const observed = await verify(record, op, op.fileId);
        if (!observed.matches) diagnose('copy_status_mismatch', null);
        op.outcome = observed.matches ? 'verified' : 'mismatch';
        await store.updateCreation(op);
        return receipt(op, { account: record.email, ...(observed.matches ? { file: fileInfo(observed.file) } : {}) });
      }
      const page = await drive.findCopy(record, op.operationId, op.driveId);
      if (page.incompleteSearch === true || page.nextPageToken || !Array.isArray(page.files) || page.files.length !== 1 || !fileId(page.files[0]?.id)) { diagnose('copy_status_lookup_uncertain', null); return receipt(op, { account: record.email, outcome: 'uncertain' }); }
      const observed = await verify(record, op, page.files[0].id);
      if (!observed.matches) diagnose('copy_status_mismatch', null);
      return receipt(op, { account: record.email, outcome: 'uncertain', ...(observed.matches ? { observedFile: fileInfo(observed.file), observation: 'matching_metadata' } : { observation: 'mismatch' }) });
    } catch (error) {
      diagnose('copy_status', error);
      return receipt(op, { account: record.email, outcome: op.acknowledged ? 'verification_unavailable' : 'uncertain' });
    }
  }
  return { copy, status };
}
