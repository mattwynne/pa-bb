import { z } from 'zod';
import { creationKey, fileId, hash, validTitle } from './native-create.mjs';
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const SHEET = 'application/vnd.google-apps.spreadsheet';
const target = { account: z.string().min(1).max(320), operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) };
export const uploadParameters = z.object({ ...target,
  source: z.object({ host: z.literal('bb-server'), threadId: z.string().regex(/^thr_[a-z0-9]+$/), path: z.string().min(1).max(1024) }).strict().describe('One explicitly requested file relative to this thread’s supported server storage root. Not a client/remote-host path.'),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), folderId: z.string().regex(/^[\w-]{1,256}$/),
  name: z.string().min(1).max(255), mimeType: z.string().min(3).max(255).describe('Explicit ordinary source MIME, never a Google-native type.'),
  mode: z.enum(['binary', 'xlsx_to_sheet']).default('binary'), preview: z.boolean().default(true),
}).strict();
export const uploadStatusParameters = z.object(target).strict();
const messages = {
  invalid: 'Select one requested file, explicit ordinary MIME/name, destination, source SHA-256 and lowercase UUID v4. XLSX conversion must be explicit.',
  source: 'Source is unavailable or unsafe. Only a regular, single-link file in supported local BB-server thread storage is accepted; no hidden/secret paths, symlinks, devices or remote/client files. Maximum 4 MiB.',
  changed: 'The selected source file/version changed. No upload was submitted. Inspect it before making a separately requested operation; do not bypass uncertainty with a new key.',
  conversion: 'This XLSX is outside the conservative import boundary (structure, archive size, macros, links, connections or unsupported formulas). Raw binary upload remains separate; no conversion was submitted.',
  duplicate: 'A same-name destination file already exists. Nothing was replaced. Inspect duplicates or explicitly choose another name; never use another key to bypass an uncertain upload.',
  incomplete: 'Destination or duplicate evidence is incomplete. No upload was submitted.',
  conflict: 'This operationId belongs to another account, request or source version. Retain its original account/key for read-only recovery.',
  busy: 'A related upload or access change is reviewing, writing or unresolved. Inspect its original receipt; do not create another key.',
  unknown: 'No upload receipt exists for this account/key. This does not prove no file exists. Do not blindly upload again.',
  scope: 'An existing owner-authorized Drive write grant is required. Only the owner can reconnect in Google Drive Settings; do not change scopes or credentials manually.',
  review: 'Upload requires a fresh exact owner review. No settings optout applies. No upload was submitted.',
};
export const uploadError = code => Object.assign(new Error(messages[code] || 'Upload is unavailable; inspect the original operation.'), { uploadCode: code });
export const uploadCategory = e => Object.hasOwn(messages, e?.uploadCode) ? e.uploadCode : 'unknown';
export const uploadMessage = e => messages[e?.uploadCode] || 'Upload or inspection is unavailable. Keep the original account and operationId; use gdrive_upload_status. Never blindly retry or replace the key.';
export const ordinaryMime = value => typeof value === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) && !value.startsWith('application/vnd.google-apps.');
export function createUploadService({ store, source, upload, assessment, diagnose = (_stage, _error) => {}, clock = () => Date.now() }) {
  const active = new Set();
  async function account(args) {
    if (typeof args.account !== 'string' || !args.account.trim() || !creationKey(args.operationId)) throw uploadError('invalid');
    const record = await store.byEmail(args.account);
    if (!record) throw uploadError('invalid');
    return record;
  }
  function receipt(op, extra = {}) {
    return { operationId: op.operationId, mode: op.mode, outcome: op.outcome, acknowledged: op.acknowledged === true,
      writeAttempted: ['writing', 'uncertain'].includes(op.claimState) ? 'unknown' : op.writeAttempted,
      retrySafe: false, ...(op.fileId ? { fileId: op.fileId, url: `https://drive.google.com/file/d/${op.fileId}/view` } : {}),
      guidance: 'Only verified confirms acknowledged provider completion and bounded readback. Binary verifies captured bytes by provider checksum; conversion is NOT Excel fidelity verification. Keep the original key. Status only reads; never replay, replace the key, repair or delete automatically.', ...extra };
  }
  async function verify(record, op, id) {
    const m = await upload.get(record, id);
    const metadataMatches = m.id === id && m.trashed === false && m.mimeType === op.resultMime && hash(m.name || '') === op.nameHash
      && m.parents?.length === 1 && m.parents[0] === op.destinationId && m.appProperties?.paLocalUpload === op.operationId;
    const evidence = op.mode === 'binary' ? { sizeBytes: Number(m.size), md5Checksum: m.md5Checksum, sha256Checksum: m.sha256Checksum,
      checksumMatches: Number(m.size) === op.sizeBytes && m.md5Checksum === op.md5 && (!m.sha256Checksum || m.sha256Checksum === op.sha256) }
      : await upload.inspectSheet(record, id, op.conversion);
    const accessMatches = (await assessment.assessDestination(record, op.destinationId)).fingerprint === op.destinationFingerprint
      && await assessment.verifyCreated(record, id, op.destinationId, op.resultMime, op.allowedAccess);
    return { matches: metadataMatches && accessMatches && (op.mode === 'binary' ? evidence.checksumMatches : evidence.structureMatches),
      file: { id, name: m.name, mimeType: m.mimeType, destinationId: op.destinationId, url: op.mode === 'binary' ? `https://drive.google.com/file/d/${id}/view` : `https://docs.google.com/spreadsheets/d/${id}/edit` }, evidence };
  }
  async function submit(raw, signal, approve) {
    const args = uploadParameters.parse(raw), record = await account(args);
    if (!fileId(args.folderId) || !validTitle(args.name) || !ordinaryMime(args.mimeType)
      || args.name.startsWith('.') || /[/\\]/.test(args.name) || (args.mode === 'xlsx_to_sheet' && args.mimeType !== XLSX)) throw uploadError('invalid');
    const requestHash = hash(JSON.stringify([args.source, args.expectedSha256, args.folderId, args.name, args.mimeType, args.mode]));
    let op = await store.getCreation(args.operationId);
    if (op && (op.kind !== 'upload' || op.subject !== record.subject || op.requestHash !== requestHash)) throw uploadError('conflict');
    if (op && op.claimState !== 'proposed') return receipt(op, { receiptOnly: true });
    const captured = await source.capture(args.source, args.expectedSha256, args.mode);
    const evidence = await assessment.assessDestination(record, args.folderId);
    await upload.duplicates(record, evidence.destinationId, args.name);
    await upload.prepare(record); // identity and write grant before preview; no mutation
    const payload = { account: record.email, operationId: args.operationId, sourceHost: 'BB server (not your browser/device)',
      sourcePath: captured.location, sourceName: captured.name, size: String(captured.sizeBytes), sha256: captured.sha256,
      mimeType: args.mimeType, mode: args.mode, title: args.name, destinationId: evidence.destinationId,
      path: evidence.path, owners: evidence.owners, audience: evidence.audience,
      conversion: args.mode === 'xlsx_to_sheet' ? JSON.stringify(captured.conversion) : 'No conversion — exact bytes.' };
    if (Buffer.byteLength(JSON.stringify(payload)) > 48_000) throw uploadError('review');
    if (!op) {
      op = { operationId: args.operationId, kind: 'upload', subject: record.subject, requestHash, mode: args.mode,
        destinationId: evidence.destinationId, destinationFingerprint: evidence.fingerprint, contextIds: evidence.contextIds,
        allowedAccess: evidence.allowedAccess, nameHash: hash(args.name), resultMime: args.mode === 'binary' ? args.mimeType : SHEET,
        sizeBytes: captured.sizeBytes, sha256: captured.sha256, md5: captured.md5, sourceVersion: captured.version,
        conversion: captured.conversion, resource: `upload:${evidence.destinationId}:${hash(args.name)}`,
        outcome: 'proposed', claimState: 'proposed', writeAttempted: false, acknowledged: false };
      if (!await store.reserveCreation(op)) throw uploadError('conflict');
    }
    if (op.sourceVersion !== captured.version || op.destinationFingerprint !== evidence.fingerprint) throw uploadError('changed');
    if (args.preview) return receipt(op, { preview: payload, next: 'Apply with exactly these arguments/key and preview=false. Owner review remains mandatory.' });
    if (typeof approve !== 'function') throw uploadError('review');
    op.claimState = 'reviewing'; op.outcome = 'reviewing';
    if (!await store.claimUploadReview(op)) throw uploadError('busy');
    active.add(op.operationId);
    let stage = 'approval'; const expires = clock() + 600_000;
    try {
      const decision = await approve(payload, signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000));
      if (decision?.outcome !== 'submitted' || decision.value?.approved !== true || Object.keys(decision.value).length !== 1) {
        op.claimState = decision?.value?.approved === false ? 'declined' : 'cancelled'; op.outcome = op.claimState;
        await store.updateCreation(op); return receipt(op);
      }
      stage = 'revalidate';
      const fresh = await source.capture(args.source, args.expectedSha256, args.mode);
      if (fresh.version !== op.sourceVersion || fresh.sha256 !== op.sha256) throw uploadError('changed');
      if ((await assessment.assessDestination(record, op.destinationId)).fingerprint !== op.destinationFingerprint) throw uploadError('changed');
      await upload.duplicates(record, op.destinationId, args.name);
      const writer = await upload.prepare(record);
      signal?.throwIfAborted(); if (clock() >= expires) throw uploadError('review');
      op.claimState = 'writing'; op.outcome = 'uncertain'; op.writeAttempted = true;
      if (!await store.startSharedCreation(op)) return receipt(await store.getCreation(op.operationId), { receiptOnly: true });
      stage = 'submission';
      const created = await writer({ bytes: fresh.bytes, name: args.name, mimeType: args.mimeType, resultMime: op.resultMime,
        destinationId: op.destinationId, operationId: op.operationId, async beforeSubmission() {
          const last = await source.capture(args.source, args.expectedSha256, args.mode);
          if (last.version !== op.sourceVersion || last.sha256 !== op.sha256) throw uploadError('changed');
          if ((await assessment.assessDestination(record, op.destinationId)).fingerprint !== op.destinationFingerprint) throw uploadError('changed');
          await upload.duplicates(record, op.destinationId, args.name);
          if (clock() >= expires) throw uploadError('review');
        } }, signal);
      if (!fileId(created?.id)) throw uploadError('incomplete');
      op.fileId = created.id; op.acknowledged = true; op.contextIds = [...new Set([...op.contextIds, created.id])];
      if (!await store.attachSharedCreation(op)) throw uploadError('busy');
      stage = 'verify';
      const observed = await verify(record, op, op.fileId);
      if (!observed.matches) throw uploadError('incomplete');
      op.claimState = 'verified'; op.outcome = 'verified'; await store.updateCreation(op);
      return receipt(op, observed);
    } catch (error) {
      diagnose(`upload_${stage}`, error);
      if (['approval', 'revalidate'].includes(stage) || error?.uploadNotSubmitted === true || error?.uploadRejected === true) {
        op.claimState = 'not_submitted'; op.outcome = 'not_created'; op.writeAttempted = stage === 'submission' && !error?.uploadNotSubmitted;
      } else { op.claimState = 'uncertain'; op.outcome = 'uncertain'; }
      try { await store.updateCreation(op); } catch (e) { diagnose('upload_receipt', e); }
      return receipt(op);
    } finally { active.delete(op.operationId); }
  }
  async function status(args) {
    const record = await account(uploadStatusParameters.parse(args));
    const op = await store.getCreation(args.operationId);
    if (!op || op.subject !== record.subject || op.kind !== 'upload') throw uploadError('unknown');
    if (active.has(op.operationId)) return receipt(op, { inProgress: true });
    if (op.claimState === 'reviewing') {
      const cancelled = { ...op, claimState: 'cancelled', outcome: 'cancelled' };
      await store.cancelSharedCreationReview(cancelled); return receipt(await store.getCreation(op.operationId));
    }
    if (!['writing', 'uncertain', 'verified'].includes(op.claimState)) return receipt(op, { receiptOnly: true });
    try {
      const id = op.fileId || await upload.find(record, op.operationId);
      if (!id) { diagnose('upload_status_lookup_uncertain', null); return receipt(op, { outcome: 'uncertain', unresolved: true }); }
      if (!op.fileId) {
        op.fileId = id; op.contextIds = [...new Set([...op.contextIds, id])];
        if (!await store.attachUploadObservation(op)) throw uploadError('busy');
      }
      const observed = await verify(record, op, id);
      if (!observed.matches) diagnose('upload_status_mismatch', null);
      if (op.acknowledged && observed.matches) {
        op.claimState = 'verified'; op.outcome = 'verified'; await store.updateCreation(op); return receipt(op, observed);
      }
      return receipt(op, { ...observed, outcome: op.claimState === 'verified' ? 'changed_since_verification' : observed.matches ? 'observed_matching' : 'uncertain', unresolved: op.claimState !== 'verified' });
    } catch (e) { diagnose('upload_status', e); return receipt(op, { outcome: 'verification_unavailable', unresolved: op.claimState !== 'verified' }); }
  }
  return { submit, status };
}
