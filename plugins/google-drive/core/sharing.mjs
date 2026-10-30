// Permission mutation orchestration. Provider authority/inheritance rules belong
// to the sharing adapter. A key is single-use, not an idempotency key at Google.
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const sharingTarget = { account: z.string().trim().min(1).max(320), operationId: z.uuid().regex(/^[0-9a-f-]+$/) };
const id = z.string().regex(/^[\w-]{1,256}$/);
const role = z.enum(['reader', 'commenter', 'writer']);
const common = { ...sharingTarget, fileId: id, preview: z.boolean().default(true) };
const audience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), emailAddress: z.email().max(320) }).strict(),
  z.object({ type: z.literal('group'), emailAddress: z.email().max(320) }).strict(),
  z.object({ type: z.literal('anyone') }).strict(),
]);
// Native provider tools require an object root (not top-level anyOf). Keep the
// strict action-specific contract below as the authoritative service boundary.
export const sharingChangeParameters = z.object({ ...common, action: z.enum(['grant', 'change', 'revoke']),
  audience: audience.optional().describe('Grant only. Named user/group email or anyone-with-link.'),
  role: role.optional().describe('Required for grant/change; omit for revoke.'),
  permissionId: id.optional().describe('Required for change/revoke; exact inspected permission ID. Omit for grant.'),
  notify: z.boolean().optional().describe('Named grants only: false by default; true opts into a sharing email. Omit for change/revoke.'),
}).strict();
export const sharingChangeSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('grant'), audience, role, notify: z.boolean().default(false) }).strict(),
  z.object({ ...common, action: z.literal('change'), permissionId: id, role }).strict(),
  z.object({ ...common, action: z.literal('revoke'), permissionId: id }).strict(),
]);
export const sharingStatusSchema = z.object(sharingTarget).strict();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messages = {
  unknown_account: 'Select an explicit connected Google Drive account.',
  unsupported: 'Sharing cannot be changed safely here. Only owned My Drive items with complete, inspectable ancestry and unambiguous direct permissions are supported. Shared drives, inherited target permissions, limited-access ancestry and unknown authority are blocked. Inspect sharing or use Google Drive directly.',
  incomplete: 'The live sharing or ancestry listing is incomplete or unavailable. This does not establish whether an earlier write applied. Inspect the saved operation before any new proposal.',
  scope_required: 'Sharing requires an existing owner-authorized Drive write grant. Read-only grants cannot change sharing. This tool never broadens OAuth access.',
  conflict: 'This operationId belongs to a different request or account. Inspect the original operation; do not generate a new key to bypass an uncertain write.',
  unknown_operation: 'No sharing receipt exists for this account and operationId. This is not proof that no permission change occurred elsewhere.',
  busy: 'Another sharing or filing operation affecting this item is reviewing, writing or unresolved. Inspect its original operation receipt before making a new proposal.',
  stale: 'Sharing, authority or target details changed since preview, or the preview expired. No new write was submitted. Inspect and make a fresh proposal.',
  invalid: 'The sharing request or approval is invalid. No new write was submitted.',
  rejected: 'Google rejected the sharing request (invalid request, policy, authority or conflict). No successful change is established. Inspect live sharing and authorization before a separately requested new proposal; this key remains consumed.',
};
export function sharingError(code) { return Object.assign(new Error(messages[code] || 'Sharing inspection or change is unavailable. Inspect the saved operation; never blindly retry.'), { sharingCode: code }); }
export const sharingCategory = error => Object.hasOwn(messages, error?.sharingCode) ? error.sharingCode : 'unknown';
export const sharingMessage = error => (messages[error?.sharingCode] || 'Sharing inspection or change is unavailable. Inspect the saved operation; never blindly retry.')
  + (error?.sharingCode === 'busy' && sharingTarget.operationId.safeParse(error.operationId).success ? ` Blocking operationId: ${error.operationId}. Use its original connected account for recovery.` : '');
export function createSharingService({ store, sharing, approve = async (_payload, _signal) => ({ outcome: 'cancelled' }), diagnose = (_stage, _error) => {}, clock = () => Date.now() }) {
  const active = new Set();
  async function record(args) { const r = await store.byEmail(args.account); if (!r) throw sharingError('unknown_account'); return r; }
  const receipt = (op, extra = {}) => ({ operationId: op.operationId, outcome: op.state, fileId: op.fileId, permissionId: op.permissionId || null,
    retrySafe: false, preview: op.preview, guidance: extra.receiptOnly ? 'Saved historical receipt only; no fresh Google read or write occurred. Use gdrive_sharing_status for current observation. Do not replay or replace the operationId.'
      : extra.outcome === 'verification_unavailable' ? 'Fresh verification is unavailable. Historical receipts are not proof of current permissions. Inspect this same operation again; never replay its write.'
      : extra.outcome === 'changed_since_verification' ? 'Current Google-visible sharing no longer matches this historical verified receipt. No write or rollback was performed. Inspect live sharing before a separately authorized new change.'
      : op.state === 'proposed' ? 'Live preview saved; no access change was submitted. To request mandatory owner approval, use the same operationId and arguments with preview=false within ten minutes.'
      : op.state === 'verified'
      ? 'Exact permission difference and unchanged other Google-visible permissions were read back. This does not prove recipient access, exhaustive privacy or notification delivery.'
      : 'Only verified confirms the exact readback. Use gdrive_sharing_status with the SAME account and operationId after interruption or uncertainty. Never replay a write or replace the key to bypass recovery.', ...extra });
  async function save(op, state) { op.state = state; await store.updateSharing(op); }
  async function change(input, signal, requestApproval = approve) {
    const parsed = sharingChangeSchema.safeParse(input);
    if (!parsed.success) throw sharingError('invalid');
    const args = parsed.data;
    const r = await record(args);
    const { preview, account, operationId, ...request } = args;
    const requestHash = hash(request);
    let op = await store.getSharing(operationId);
    let freshlyInspected = false;
    if (op && (op.subject !== r.subject || op.requestHash !== requestHash)) throw sharingError('conflict');
    if (!op) {
      const inspected = await sharing.propose(r, request);
      op = { operationId, subject: r.subject, fileId: args.fileId, requestHash, request, ...inspected,
        createdAt: clock(), state: 'proposed' };
      if (!await store.reserveSharing(op)) return change(input, signal, requestApproval); // reservation race only; never a provider retry
      freshlyInspected = true;
    }
    if (preview || op.state !== 'proposed') return receipt(op, { receiptOnly: !freshlyInspected, freshlyInspected });
    if (clock() - op.createdAt >= 10 * 60_000) { await save(op, 'expired'); return receipt(op); }
    if (!await store.claimSharing(op.operationId, op.fileId)) throw Object.assign(sharingError('busy'), { operationId: await store.activeSharing(op.fileId) });
    op.state = 'reviewing'; active.add(op.operationId);
    let stage = 'approval';
    try {
      signal?.throwIfAborted();
      const decision = await requestApproval({ ...op.preview, operationId: op.operationId }, signal);
      if (decision?.outcome !== 'submitted' || decision.value?.approved !== true || Object.keys(decision.value).length !== 1) {
        const reason = ['user', 'timeout', 'request-aborted', 'thread-stopped', 'thread-deleted', 'plugin-disposed', 'server-restarted'].includes(decision?.reason) ? decision.reason : 'invalid';
        if (decision?.outcome !== 'submitted' && reason !== 'user') diagnose(`sharing_approval_${reason}`, null);
        await save(op, decision?.outcome === 'submitted' && decision.value?.approved === false ? 'declined' : 'cancelled'); return receipt(op);
      }
      if (clock() - op.createdAt >= 10 * 60_000) { await save(op, 'expired'); return receipt(op); }
      const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(10 * 60_000 - (clock() - op.createdAt))));
      const writeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      stage = 'revalidate';
      const fresh = await sharing.propose(r, request);
      if (fresh.fingerprint !== op.fingerprint) { await save(op, 'stale'); return receipt(op); }
      // Scope/identity preflight occurs before durable writing, and again at submission.
      const writer = await sharing.prepare(r);
      if (clock() - op.createdAt >= 10 * 60_000) { await save(op, 'expired'); return receipt(op); }
      writeSignal.throwIfAborted();
      stage = 'reserve_write';
      if (!await store.startSharingWrite(op)) throw sharingError('stale');
      op.state = 'writing'; // consumed even if interrupted before the HTTP request
      stage = 'write';
      const result = await writer(request, op.permissionId, writeSignal);
      if (result.permissionId) op.permissionId = result.permissionId;
      op.providerAcknowledged = true;
      await save(op, 'uncertain'); // save provider ID before verification
      stage = 'verify';
      const verified = await sharing.verify(r, op);
      if (verified.permissionId) op.permissionId = verified.permissionId;
      await save(op, verified.matches ? 'verified' : 'uncertain');
      if (!verified.matches) diagnose('sharing_verification_mismatch', null);
      return receipt(op);
    } catch (error) {
      diagnose(`sharing_${stage}`, error);
      const state = stage === 'approval' ? 'cancelled' : ['revalidate', 'reserve_write'].includes(stage) ? 'not_submitted'
        : error?.sharingNotSubmitted === true ? 'not_submitted' : error?.sharingRejected === true ? 'rejected' : 'uncertain';
      try { await save(op, state); } catch (storageError) { diagnose('sharing_receipt', storageError); }
      return receipt(op, { error: sharingMessage(error) });
    } finally { active.delete(op.operationId); }
  }
  async function status(input) {
    const parsed = sharingStatusSchema.safeParse(input); if (!parsed.success) throw sharingError('invalid');
    const r = await record(parsed.data); const op = await store.getSharing(parsed.data.operationId);
    if (!op || op.subject !== r.subject) throw sharingError('unknown_operation');
    if (active.has(op.operationId)) return receipt(op, { inProgress: true });
    if (op.state === 'reviewing') {
      if (await store.cancelSharingReview(op.operationId)) op.state = 'cancelled';
      else return receipt(await store.getSharing(op.operationId), { inProgress: true });
    }
    if (!['writing', 'uncertain', 'verified'].includes(op.state)) return receipt(op, { receiptOnly: true });
    try {
      const observed = await sharing.verify(r, op);
      // Inspection only. Never retry mutations. An unchanged state is not proof
      // that an interrupted HTTP request cannot still complete later.
      // A historical verified operation must not acquire a new unresolved lock
      // merely because a later, separately authorized change now exists.
      if (op.state === 'verified' && !observed.matches) return receipt(op, { outcome: 'changed_since_verification', readbackMatches: false });
      if (observed.permissionId) op.permissionId = observed.permissionId;
      // A matching observation cannot establish that a lost-response request
      // finished. Legacy receipts without acknowledgement are conservative too.
      if (op.state !== 'verified' && op.providerAcknowledged !== true) {
        if (!observed.matches) diagnose('sharing_recovery_mismatch', null);
        return receipt(op, {
          outcome: observed.matches ? 'observed_matching' : 'uncertain',
          readbackMatches: observed.matches,
          unresolved: true,
          guidance: 'Current sharing was observed only; an unacknowledged request may still complete. The item remains locked. Never replay or replace the operationId.',
        });
      }
      await save(op, observed.matches ? 'verified' : 'uncertain');
      if (!observed.matches) diagnose('sharing_recovery_mismatch', null);
      return receipt(op);
    } catch (error) { diagnose('sharing_recovery', error); return receipt(op, { outcome: 'verification_unavailable', error: sharingMessage(error) }); }
  }
  return { change, status };
}
