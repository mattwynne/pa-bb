// Durable single-use creation lifecycle shared by native Docs and Sheets.
// Recovery only reads. A reserved key never authorizes another write.
import { createHash } from 'node:crypto';
import { docsError, docsErrorMessage } from './docs-edit.mjs';
export const hash = text => createHash('sha256').update(text).digest('hex');
export const fileId = value => typeof value === 'string' && /^[\w-]{1,256}$/.test(value);
export const creationKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const messages = {
  invalid_input: 'Use an explicit connected account, lowercase UUID v4 operationId, title and bounded initial content. Destination must be root or an explicit folder ID. See the native creation skill for content limits.',
  destination_rejected: 'Choose My Drive root or an eligible writable My Drive folder. Shared drives and incomplete or unverified access are not supported. No file was created.',
  review_unavailable: 'The shared destination or complete requested content cannot be reviewed within the supported limits. No file was created.',
  busy: 'An operation affecting this destination or its ancestry is reviewing, writing or unresolved. Inspect its original receipt before trying another operation.',
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
  if (!fileId(folder.id) || (folderId !== 'root' && folder.id !== folderId) || folder.trashed !== false || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.capabilities?.canAddChildren !== true) throw creationError('destination_rejected');
  if (folderId !== 'root') {
    const meta = await drive.getSharingMetadata(record, folder.id);
    const permissions = await drive.listPermissions(record, folder.id);
    if (meta.id !== folder.id || meta.driveId || !Array.isArray(permissions.permissions)
      || meta.owners?.length !== 1 || typeof meta.owners[0].me !== 'boolean' || typeof meta.shared !== 'boolean') throw creationError('destination_rejected');
    if (meta.shared === false && meta.owners[0].me === true && !permissions.nextPageToken && permissions.permissions.length === 1
      && permissions.permissions[0].type === 'user' && permissions.permissions[0].role === 'owner'
      && permissions.permissions[0].emailAddress?.toLowerCase() === record.email.toLowerCase()) return { id: folder.id, mode: 'legacy' };
    if (meta.shared === true || meta.owners[0].me === false) return { id: folder.id, mode: 'shared' };
    throw creationError('destination_rejected');
  }
  return { id: folder.id, mode: 'legacy' };
}
export function createNativeCreationService({ store, drive, creation, assessment, spec, diagnose = () => {}, clock = () => Date.now() }) {
  const active = new Set();
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
        : ['declined', 'cancelled'].includes(outcome) ? 'The review did not approve creation. No file was created by this operation.'
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
    if (op.sharedVersion === 1) {
      if (active.has(op.operationId)) return { ...result(op), inProgress: true };
      if (op.claimState === 'reviewing') {
        const cancelled = { ...op, claimState: 'cancelled', outcome: 'cancelled' };
        if (await store.cancelSharedCreationReview(cancelled)) return result(cancelled);
        return result(await store.getCreation(op.operationId), undefined, true);
      }
      if (!['writing', 'uncertain', 'verified'].includes(op.claimState)) return result(op, op.outcome, true);
      try {
        let id = resourceId(op);
        if (!id) {
          const page = await creation.find(record, op.operationId);
          if (page.incompleteSearch === true || page.nextPageToken || !Array.isArray(page.files) || page.files.length !== 1 || !fileId(page.files[0]?.id)) {
            diagnose(`${spec.stage}_lookup_uncertain`, null);
            return result(op, 'uncertain');
          }
          id = page.files[0].id;
        }
        const observed = { ...op, [spec.idField]: id };
        const matches = await verify(record, observed) && (await assessment.assessDestination(record, op.destinationId)).fingerprint === op.destinationFingerprint
          && await assessment.verifyCreated(record, id, op.destinationId, spec.mimeType, op.allowedAccess);
        if (!matches) diagnose(`${spec.stage}_status_mismatch`, docsError('unsupported_document'));
        if (op.createAcknowledged && op.populateAcknowledged && matches) {
          op.outcome = 'verified'; op.claimState = 'verified'; await save(op); return result(op);
        }
        if (op.claimState === 'verified') return { ...result(op, 'changed_since_verification'), readbackMatches: matches };
        return { ...result(observed, matches ? 'observed_matching' : 'uncertain'), acknowledged: false, unresolved: true };
      } catch (error) { diagnose(`${spec.stage}_status`, error); return { ...result(op, 'verification_unavailable'), ...(['writing', 'uncertain'].includes(op.claimState) ? { unresolved: true } : {}) }; }
    }
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
  async function create(args, signal, approve) {
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
    const target = await destination(drive, record, args.folderId);
    const destinationId = target.id;
    const writer = await creation.prepare(record);
    signal?.throwIfAborted();
    if (target.mode === 'shared') return createShared(args, record, requestHash, destinationId, signal, approve);
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
  async function createShared(args, record, requestHash, destinationId, signal, approve) {
    if (!assessment || typeof approve !== 'function') throw creationError('review_unavailable');
    let evidence;
    try { evidence = await assessment.assessDestination(record, destinationId); } catch { throw creationError('destination_rejected'); }
    const content = spec.reviewContent(args);
    const payload = { account: record.email, operationId: args.operationId, destinationId, path: evidence.path,
      owners: evidence.owners, audience: evidence.audience, title: args.title, mimeType: spec.mimeType, content };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 48_000) throw creationError('review_unavailable');
    const op = { operationId: args.operationId, kind: spec.kind, subject: record.subject, requestHash, destinationId,
      titleHash: hash(args.title), ...spec.expected(args), sharedVersion: 1, destinationFingerprint: evidence.fingerprint,
      contextIds: evidence.contextIds, allowedAccess: evidence.allowedAccess, claimState: 'reviewing', outcome: 'reviewing', writeAttempted: false,
      createAcknowledged: false, populateAcknowledged: false };
    if (!await store.reserveSharedCreation(op)) {
      const existing = await store.getCreation(op.operationId);
      if (existing) {
        if (!belongs(existing) || existing.subject !== record.subject || existing.requestHash !== requestHash) throw creationError('operation_conflict');
        return result(existing, existing.outcome, true);
      }
      throw creationError('busy');
    }
    active.add(op.operationId);
    const expires = clock() + 600_000;
    let stage = 'approval';
    try {
      const reviewSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
      const decision = await approve(payload, reviewSignal);
      if (decision?.outcome !== 'submitted' || decision.value?.approved !== true || Object.keys(decision.value).length !== 1) {
        op.outcome = decision?.outcome === 'submitted' && decision.value?.approved === false ? 'declined' : 'cancelled'; op.claimState = op.outcome;
        await save(op); return result(op);
      }
      async function recheck() {
        signal?.throwIfAborted();
        if (clock() >= expires) throw creationError('review_unavailable');
        const next = await assessment.assessDestination(record, destinationId);
        if (next.destinationId !== destinationId || next.fingerprint !== op.destinationFingerprint) throw creationError('destination_rejected');
        return creation.prepare(record);
      }
      stage = 'revalidate';
      const writer = await recheck();
      op.claimState = 'writing'; op.outcome = 'uncertain'; op.writeAttempted = true;
      if (!await store.startSharedCreation(op)) return result(await store.getCreation(op.operationId), undefined, true);
      stage = 'create';
      const created = await writer.create({ operationId: op.operationId, title: args.title, folderId: destinationId }, signal);
      if (!fileId(created?.id)) throw docsError('unsupported_document');
      op[spec.idField] = created.id; op.createAcknowledged = true; op.contextIds = [...new Set([...op.contextIds, created.id])];
      if (!await store.attachSharedCreation(op)) throw creationError('busy');
      stage = 'prepopulate';
      await spec.populate({ ...writer, async populate(input, writeSignal) {
        const fresh = await recheck();
        stage = 'populate';
        return fresh.populate(input, writeSignal);
      } }, record, op, args, signal);
      op.populateAcknowledged = true; await save(op);
      stage = 'verify';
      if (!await verify(record, op) || (await assessment.assessDestination(record, destinationId)).fingerprint !== op.destinationFingerprint
        || !await assessment.verifyCreated(record, op[spec.idField], destinationId, spec.mimeType, op.allowedAccess)) throw docsError('unsupported_document');
      op.claimState = 'verified'; op.outcome = 'verified'; await save(op); return result(op);
    } catch (error) {
      diagnose(`${spec.stage}_${stage}`, error);
      if (['approval', 'revalidate'].includes(stage) || (stage === 'create' && (error?.creationRejected || error?.creationWriteAttempted === false)) || stage === 'prepopulate') {
        op.claimState = 'not_submitted'; op.outcome = resourceId(op) ? 'incomplete' : 'not_created';
      } else { op.claimState = 'uncertain'; op.outcome = 'uncertain'; }
      try { await save(op); } catch (storageError) { diagnose(`${spec.stage}_receipt`, storageError); }
      return result(op);
    } finally { active.delete(op.operationId); }
  }
  return { create, inspect };
}
