// Bounded filing only: one folder or one existing file. Never content/ACL writes.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fileLink } from './file-link.mjs';
export const filingId = z.string().regex(/^[\w-]{1,256}$/);
const target = { account: z.string().trim().min(1).max(320), operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) };
export const folderParameters = z.object({ ...target, parentId: filingId, name: z.string().min(1).max(255), preview: z.boolean().default(true) }).strict();
export const moveParameters = z.object({ ...target, fileId: filingId, expectedParentId: filingId, folderId: filingId, preview: z.boolean().default(true) }).strict();
export const filingStatusParameters = z.object(target).strict();
export const filingHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messages = {
  invalid: 'Use an explicit connected account, lowercase UUID v4 operationId and exact folder/file IDs. Folder names must be bounded ordinary text.',
  account: 'Select an explicit connected Google Drive account.',
  unsupported: 'Filing supports owned My Drive folder creation and existing owned files that Google reports movable. Folder-tree moves, shared drives, shortcuts, limited-access ancestry, trash and unknown authority are not supported.',
  incomplete: 'The folder, ancestry or permission listing is incomplete. No new filing write was submitted; inspect any existing operation before retrying.',
  duplicate: 'An exact-name folder already exists in the selected parent. Inspect it and its sharing; do not automatically create another or select an ambiguous duplicate.',
  scope: 'Filing requires an existing owner-authorized drive or drive.file grant and access to these items. It never expands OAuth. Docs-only and read-only grants are insufficient.',
  conflict: 'This operationId belongs to another account or request. Inspect the original operation; do not replace its key to bypass uncertainty.',
  unknown: 'No filing receipt exists for this account and operationId. This does not establish whether a previous write applied.',
  sharing_busy: 'A reviewed or unresolved sharing operation affects the item or its ancestry. Inspect its original gdrive_sharing_status receipt before filing; do not bypass an unknown permission write.',
  busy: 'Another filing operation for this file or exact folder request is reviewing, writing or unresolved. Inspect its operationId; do not bypass it with a new key.',
  stale: 'The source, destination, visible access or authority changed since preview. No new write was submitted. Inspect before a separately requested proposal.',
  rejected: 'Google rejected the filing write. The key remains consumed; inspect authorization, policy and current location before proposing a new operation.',
};
export function filingError(code) { return Object.assign(new Error(messages[code] || 'Filing is unavailable. Inspect the saved operation; never blindly retry.'), { filingCode: code }); }
export const filingCategory = error => Object.hasOwn(messages, error?.filingCode) ? error.filingCode : 'unknown';
export const filingMessage = error => messages[error?.filingCode] || 'Filing inspection or writing is unavailable. If submission may have started, use gdrive_filing_status with the same account and operationId; never blindly retry.';
export function createFilingService({ store, operations, filing, approve = async (_payload, _signal) => ({ outcome: 'cancelled' }), diagnose = (_stage, _error) => {}, clock = () => Date.now() }) {
  const active = new Set();
  const receipt = (op, extra = {}) => ({ operationId: op.operationId, kind: op.kind, outcome: op.state, fileId: op.fileId || null,
    destinationId: op.destinationId, retrySafe: false, writeAttempted: ['writing', 'uncertain'].includes(op.state) ? 'unknown' : op.writeAttempted,
    // Receipts written by the original Docs-only implementation lack mimeType.
    mimeType: op.mimeType ?? (op.kind === 'folder' ? 'application/vnd.google-apps.folder' : 'application/vnd.google-apps.document'),
    ...(op.fileId ? { url: fileLink(op.fileId, op.mimeType ?? (op.kind === 'folder' ? 'application/vnd.google-apps.folder' : 'application/vnd.google-apps.document')) } : {}),
    guidance: 'Preview/approval is not completion. Only verified confirms exact parent readback; it does not certify exhaustive privacy, file content or rendering. After interruption use gdrive_filing_status with the SAME account and operationId. Never replay, roll back or replace a key to bypass uncertainty.', ...extra });
  async function record(args) { const r = await store.byEmail(args.account); if (!r) throw filingError('account'); return r; }
  async function save(op, state) { op.state = state; await operations.save(op); }
  async function checkSharing(inspected) {
    for (const id of inspected.contextIds || []) if (await store.activeSharing(id)) throw filingError('sharing_busy');
  }
  async function change(kind, input, signal, requestApproval = approve) {
    const parsed = (kind === 'folder' ? folderParameters : moveParameters).safeParse(input);
    if (!parsed.success) throw filingError('invalid');
    const args = parsed.data;
    if (kind === 'folder' && (!args.name.trim() || !args.name.isWellFormed() || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(args.name))) throw filingError('invalid');
    const r = await record(args);
    const { account, preview, operationId, ...request } = args;
    const requestHash = filingHash([kind, request]);
    let op = await operations.get(operationId), fresh = false;
    if (op && (op.subject !== r.subject || op.requestHash !== requestHash)) throw filingError('conflict');
    if (!op) {
      const inspected = await filing.propose(r, kind, request);
      await checkSharing(inspected);
      op = { operationId, subject: r.subject, requestHash, kind, state: 'proposed', createdAt: clock(), writeAttempted: false, ...inspected };
      if (!await operations.reserve(op)) return change(kind, input, signal, requestApproval); // local reservation race, never provider retry
      fresh = true;
    }
    if (preview || op.state !== 'proposed') return receipt(op, { receiptOnly: !fresh, preview: op.preview, requiresApproval: op.requiresApproval });
    if (clock() - op.createdAt >= 600_000) { await save(op, 'expired'); return receipt(op); }
    if (!await operations.claim(op)) throw filingError('busy');
    op.state = 'reviewing'; active.add(op.operationId);
    let stage = 'approval';
    try {
      signal?.throwIfAborted();
      // Ordinary owner-only filing uses the explicit request, like native creation.
      // Shared/possibly changed audiences always require exact native owner review.
      if (op.requiresApproval) {
        const d = await requestApproval({ ...op.preview, operationId }, signal);
        if (d?.outcome !== 'submitted' || d.value?.approved !== true || Object.keys(d.value).length !== 1) {
          if (d?.outcome !== 'submitted') diagnose('filing_approval_cancelled', null);
          await save(op, d?.outcome === 'submitted' && d.value?.approved === false ? 'declined' : 'cancelled'); return receipt(op);
        }
      }
      if (clock() - op.createdAt >= 600_000) { await save(op, 'expired'); return receipt(op); }
      stage = 'revalidate';
      const next = await filing.propose(r, kind, request);
      await checkSharing(next);
      if (next.fingerprint !== op.fingerprint) { await save(op, 'stale'); return receipt(op); }
      const writer = await filing.prepare(r);
      signal?.throwIfAborted();
      if (clock() - op.createdAt >= 600_000) { await save(op, 'expired'); return receipt(op); }
      stage = 'reserve_write';
      if (!await operations.start(op)) throw filingError('stale');
      op.state = 'writing'; op.writeAttempted = true;
      stage = 'write';
      const writeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, 600_000 - (clock() - op.createdAt)))]) : AbortSignal.timeout(Math.max(1, 600_000 - (clock() - op.createdAt)));
      const result = await writer(kind, { ...request, destinationId: op.destinationId, sourceParentId: op.sourceParentId, operationId }, writeSignal);
      if (!filingId.safeParse(result?.id).success || (kind === 'move' && result.id !== op.fileId)) throw filingError('incomplete');
      op.fileId = result.id;
      await save(op, 'uncertain'); // durable returned ID before readback
      stage = 'verify';
      const observed = await filing.verify(r, op);
      await save(op, observed.matches ? 'verified' : 'uncertain');
      if (!observed.matches) diagnose('filing_verification_mismatch', null);
      return receipt(op, { readbackMatches: observed.matches, visibleAccess: observed.visibleAccess });
    } catch (error) {
      diagnose(`filing_${stage}`, error);
      const state = ['approval', 'revalidate', 'reserve_write'].includes(stage) || error?.filingNotSubmitted === true ? 'not_submitted'
        : error?.filingRejected === true ? 'rejected' : 'uncertain';
      try { await save(op, state); } catch (storageError) { diagnose('filing_receipt', storageError); }
      return receipt(op, { error: filingMessage(error) });
    } finally { active.delete(op.operationId); }
  }
  async function status(input) {
    const parsed = filingStatusParameters.safeParse(input); if (!parsed.success) throw filingError('invalid');
    const r = await record(parsed.data), op = await operations.get(parsed.data.operationId);
    if (!op || op.subject !== r.subject) throw filingError('unknown');
    if (active.has(op.operationId)) return receipt(op, { inProgress: true });
    if (op.state === 'reviewing') { await operations.cancelReview(op.operationId); return receipt(await operations.get(op.operationId), { receiptOnly: true }); }
    if (!['writing', 'uncertain', 'verified'].includes(op.state)) return receipt(op, { receiptOnly: true });
    try {
      if (!op.fileId) {
        const found = await filing.findFolder(r, op.operationId);
        if (!found) { diagnose('filing_lookup_uncertain', null); return receipt(op, { outcome: 'uncertain' }); }
        op.fileId = found;
      }
      const observed = await filing.verify(r, op);
      if (op.state === 'verified') return receipt(op, { outcome: observed.matches ? 'verified' : 'changed_since_verification', readbackMatches: observed.matches, visibleAccess: observed.visibleAccess });
      // A late move can still be in flight. Matching current parents do not prove
      // attribution or terminal HTTP completion: retain the unresolved lock.
      if (op.kind === 'move') return receipt(op, { outcome: observed.matches ? 'observed_matching' : 'uncertain', readbackMatches: observed.matches, unresolved: true, visibleAccess: observed.visibleAccess });
      await save(op, observed.matches ? 'verified' : 'uncertain');
      return receipt(op, { readbackMatches: observed.matches, visibleAccess: observed.visibleAccess });
    } catch (error) { diagnose('filing_status', error); return receipt(op, { outcome: 'verification_unavailable', error: filingMessage(error) }); }
  }
  return { createFolder: (args, signal, approval) => change('folder', args, signal, approval), move: (args, signal, approval) => change('move', args, signal, approval), status };
}
