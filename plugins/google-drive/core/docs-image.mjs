// One additive inline PNG at an inspected paragraph start. No deletion/raw requests.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { documentId, inspectDocument, rejectSuggestions, docsError, docsErrorMessage } from './docs-edit.mjs';
import { docsApprovalDecision, diagnoseDocsApproval } from './docs-approval.mjs';
const target = { account: z.string().min(1).max(320), document: z.string().min(1).max(1024) };
export const imageInspectSchema = z.object(target).strict();
export const imageStatusSchema = z.object({ account: target.account, operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) }).strict();
export const imageSchema = z.object({ ...target, operationId: imageStatusSchema.shape.operationId,
  expectedRevisionId: z.string().min(1).max(2048), tabId: z.string().min(1).max(256),
  index: z.number().int().min(1).max(50000), uri: z.string().min(1).max(2000),
  widthPt: z.number().finite().min(18).max(432), preview: z.boolean().default(true),
}).strict();
const messages = {
  invalid: 'Use a single-use lowercase UUID v4, explicit tab, current inspected paragraph-start UTF-16 index and width 18–432 pt. Only additive public HTTPS PNG insertion is supported; no text replacement or alt-text mutation.',
  unsupported: 'Image insertion requires a complete bounded suggestion-free document with simple body paragraphs and optional inline images in every tab. Tables, lists, named ranges, headers/footers, positioned objects and other indexed structures are unsupported. Paragraph editing remains unavailable on documents containing images; page-only formatting is separate.',
  approval_required: 'Docs approval was re-enabled before submission. No write was attempted. Prepare a fresh reviewed proposal.',
  asset: 'Use an already-public HTTPS PNG URL without credentials, query or fragment, on port 443. No redirects, private/reserved networks, IPv6-only hosts, SVG, animated/interlaced PNG, compressed metadata or conversion/hosting. PNG must be 8-bit RGB/RGBA, at most 2 MiB, 4 megapixels and 8192 pixels per side.',
  stale: 'The inspected document or public asset changed, or the proposal expired. Nothing new was submitted. Inspect again for a separately requested proposal; do not bypass unresolved operations with a new key.',
  conflict: 'This operationId belongs to another operation/account/request. Recover the original operation with the SAME key.',
  busy: 'A Docs image or formatting operation is reviewing, writing or unresolved on this document. Recover that operation before another edit.',
  unknown_operation: 'No image receipt exists for this account/key. This is not proof that no external write occurred.',
};
export const imageError = code => Object.assign(new Error(messages[code] || 'Image insertion is unavailable. Recover the SAME account/key; never replay an uncertain write.'), { imageCode: code });
export const imageCategory = error => Object.hasOwn(messages, error?.imageCode) ? error.imageCode : 'unknown';
export const imageMessage = error => messages[error?.imageCode] || (error?.docsCode ? docsErrorMessage(error) : 'Image inspection or verification is unavailable. Use gdocs_image_status with the SAME account/key; never replay or replace an uncertain operation.');
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function imageTabs(doc) {
  const result = [];
  function visit(nodes, depth = 0) {
    if (!Array.isArray(nodes) || depth > 16) throw imageError('unsupported');
    for (const t of nodes) { if (!object(t)) throw imageError('unsupported'); result.push(t); if (t.childTabs !== undefined) visit(t.childTabs, depth + 1); }
  }
  visit(doc?.tabs); return result;
}
// Reuse the strict contiguous UTF-16 text validator with one-code-unit object
// placeholders. Keep the original document for exact non-target preservation.
export function inspectImages(doc, id) {
  if (!object(doc) || Buffer.byteLength(JSON.stringify(doc)) > 1_048_576) throw imageError('unsupported');
  const copy = structuredClone(doc), originals = imageTabs(doc), all = imageTabs(copy);
  for (const [i, tab] of all.entries()) {
    const data = tab.documentTab;
    if (!object(data) || Object.keys(data.namedRanges || {}).length || Object.keys(data.lists || {}).length) throw imageError('unsupported');
    const objects = data.inlineObjects || {}, seen = new Set();
    if (!object(objects)) throw imageError('unsupported');
    for (const p of data.body?.content || []) {
      if (p.paragraph?.bullet) throw imageError('unsupported');
      for (const e of p.paragraph?.elements || []) {
        if (!e.inlineObjectElement) continue;
        const value = e.inlineObjectElement, key = value.inlineObjectId;
        if (Object.keys(e).some(k => !['startIndex', 'endIndex', 'inlineObjectElement'].includes(k)) || Object.keys(value).some(k => !['inlineObjectId', 'textStyle'].includes(k)) || typeof key !== 'string' || !key.length || key.length > 256 || seen.has(key) || !object(objects[key]) || objects[key].objectId !== key || !object(objects[key].inlineObjectProperties?.embeddedObject?.imageProperties) || e.endIndex !== e.startIndex + 1) throw imageError('unsupported');
        seen.add(key);
        delete e.inlineObjectElement; e.textRun = { content: '\uFFFC', ...(value.textStyle ? { textStyle: value.textStyle } : {}) };
      }
    }
    if (Object.keys(objects).length !== seen.size || seen.size > 100) throw imageError('unsupported');
    // Suggestions anywhere in original object maps must not be hidden by removal.
    delete data.inlineObjects;
    if (!originals[i]?.documentTab) throw imageError('unsupported');
  }
  // Includes object-map suggestions, not just the text surrogate.
  rejectSuggestions(doc);
  const inspected = inspectDocument(copy, id);
  return { documentId: id, revisionId: inspected.revisionId, title: inspected.title,
    tabs: originals.map(t => ({ tabId: t.tabProperties.tabId, title: String(t.tabProperties.title || '').slice(0, 256),
      paragraphs: t.documentTab.body.content.filter(p => p.paragraph).map(p => ({ index: p.startIndex, endIndex: p.endIndex,
        text: p.paragraph.elements.map(e => e.textRun?.content ?? '\uFFFC').join(''),
        inlineObjects: p.paragraph.elements.filter(e => e.inlineObjectElement).map(e => ({ index: e.startIndex, objectId: e.inlineObjectElement.inlineObjectId })) })) })), complete: true };
}
function canonical(doc) {
  const copy = structuredClone(doc); delete copy.revisionId;
  for (const t of imageTabs(copy)) {
    const data = t.documentTab;
    if (data.inlineObjects && !Object.keys(data.inlineObjects).length) delete data.inlineObjects;
    for (const value of Object.values(data.inlineObjects || {})) {
      // Google rotates retrieval URIs. Source URI and every other property stay exact.
      const props = value.inlineObjectProperties?.embeddedObject?.imageProperties;
      if (props) delete props.contentUri;
    }
    for (const p of data.body.content) {
      if (!p.paragraph) continue;
      const runs = [];
      for (const e of p.paragraph.elements) {
        const current = structuredClone(e), last = runs.at(-1);
        if (current.textRun) {
          current.textRun.textStyle ||= {};
          if (last?.textRun && isDeepStrictEqual(last.textRun.textStyle, current.textRun.textStyle)) {
            last.textRun.content += current.textRun.content; last.endIndex = current.endIndex; continue;
          }
        }
        runs.push(current);
      }
      p.paragraph.elements = runs;
    }
  }
  return copy;
}
export function imageRequest(args) {
  return { insertInlineImage: { uri: args.uri, location: { tabId: args.tabId, index: args.index }, objectSize: { width: { magnitude: args.widthPt, unit: 'PT' } } } };
}
function plan(doc, args, asset) {
  const inspected = inspectImages(doc, documentId(args.document));
  const allUnits = inspected.tabs.reduce((n, t) => n + t.paragraphs.reduce((units, p) => units + p.endIndex - p.index, 0), 0);
  const targetData = imageTabs(doc).find(t => t.tabProperties.tabId === args.tabId)?.documentTab;
  // Reserve the one-unit/object addition plus conservative serialized metadata
  // headroom, rather than authorizing a result our own recovery cannot inspect.
  if (allUnits + 1 > 50000 || Object.keys(targetData?.inlineObjects || {}).length >= 100 || Buffer.byteLength(JSON.stringify(doc)) > 1_048_576 - 32768) throw imageError('unsupported');
  if (inspected.revisionId !== args.expectedRevisionId) throw imageError('stale');
  const paragraph = inspected.tabs.find(t => t.tabId === args.tabId)?.paragraphs.find(p => p.index === args.index);
  const heightPt = args.widthPt * asset.height / asset.width;
  if (!paragraph || heightPt < 1 || heightPt > 648) throw imageError('invalid');
  const proposal = { documentId: inspected.documentId, title: inspected.title, expectedRevisionId: inspected.revisionId,
    tabId: args.tabId, index: args.index, paragraphText: paragraph.text.slice(0, 500), uri: args.uri,
    widthPt: args.widthPt, heightPt, asset,
    limits: 'Add one inline PNG before this paragraph’s existing content; delete nothing. URI is already public, is saved by Google and is fetched once by Google. Public URL bytes can change after checking. API readback verifies location, size and source URI, not embedded bytes or visual rendering. No alt-text write, headers, replacement or asset hosting.' };
  return { before: hash(canonical(doc)), beforeDocument: canonical(doc), proposal };
}
// Remove exactly the one new inline object, reverse its one UTF-16-unit shift,
// then compare every original text/style/tab/object/property (except transient URIs).
export function imageReadback(doc, op) {
  inspectImages(doc, op.documentId);
  const copy = structuredClone(doc), tab = imageTabs(copy).find(t => t.tabProperties.tabId === op.request.tabId), data = tab?.documentTab;
  const p = data?.body.content.find(p => p.startIndex === op.request.index && p.paragraph);
  const first = p?.paragraph.elements[0], key = first?.inlineObjectElement?.inlineObjectId;
  if (!key || first.startIndex !== op.request.index || first.endIndex !== first.startIndex + 1 || (op.objectId && key !== op.objectId)) return { matches: false };
  const originalTab = imageTabs(op.beforeDocument).find(t => t.tabProperties.tabId === op.request.tabId);
  if (originalTab.documentTab.inlineObjects?.[key]) return { matches: false };
  const embedded = data.inlineObjects[key]?.inlineObjectProperties?.embeddedObject;
  const dimensionMatches = (d, n) => d?.unit === 'PT' && Number.isFinite(d.magnitude) && Math.abs(d.magnitude - n) <= 0.001;
  if (embedded?.imageProperties?.sourceUri !== op.request.uri || !dimensionMatches(embedded?.size?.width, op.request.widthPt) || !dimensionMatches(embedded?.size?.height, op.proposal.heightPt)) return { matches: false };
  p.paragraph.elements.shift(); delete data.inlineObjects[key];
  for (const item of data.body.content) {
    if (item.startIndex > op.request.index) item.startIndex--;
    if (item.endIndex > op.request.index) item.endIndex--;
    for (const e of item.paragraph?.elements || []) {
      if (e.startIndex > op.request.index) e.startIndex--;
      if (e.endIndex > op.request.index) e.endIndex--;
    }
  }
  return { matches: isDeepStrictEqual(canonical(copy), op.beforeDocument), objectId: key };
}
export function createDocsImageService({ store, drive, docs, assets, diagnose = (_stage, _error) => {}, approvalRequired = async () => true, clock = () => Date.now() }) {
  const active = new Set();
  const needsApproval = async () => { try { return (await approvalRequired()) !== false; } catch { throw docsError('approval_policy_unavailable'); } };
  async function record(account) { const r = await store.byEmail(account); if (!r) throw docsError('unknown_account'); return r; }
  async function load(r, id) { const f = await drive.getFile(r, id); if (f.id !== id || f.trashed !== false || f.mimeType !== 'application/vnd.google-apps.document') throw docsError('wrong_type'); const d = await docs.inspect(r, id); inspectImages(d, id); return d; }
  const receipt = (op, extra = {}) => ({ operationId: op.operationId, documentId: op.documentId, outcome: op.state, retrySafe: false,
    providerAcknowledged: !!op.appliedRevision && !!op.objectId, approval: op.approval || 'not_checked', objectId: op.objectId || null,
    guidance: 'Only verified confirms the acknowledged inline-object insertion, API source URI/dimensions and preservation of original content/styles. Not proof of image bytes, visual rendering or alt text. After uncertainty use gdocs_image_status with SAME account/key; never replay, roll back or replace the key.', ...extra });
  async function save(op, state) { op.state = state; await store.images.update(op); }
  async function inspect(input) { const args = imageInspectSchema.parse(input), r = await record(args.account); return { account: r.email, ...inspectImages(await load(r, documentId(args.document)), documentId(args.document)), locationRule: 'Only listed paragraph-start indices are supported. Existing text is preserved; inline objects occupy one UTF-16 unit.' }; }
  async function insert(input, signal, approve) {
    const parsed = imageSchema.safeParse(input); if (!parsed.success) throw imageError('invalid');
    const args = parsed.data, r = await record(args.account), id = documentId(args.document);
    const { account, preview, ...request } = args; request.document = id;
    const requestHash = hash(request);
    let op = await store.images.get(args.operationId);
    if (op && (op.subject !== r.subject || op.requestHash !== requestHash)) throw imageError('conflict');
    if (!op) {
      const asset = await assets.inspect(args.uri, signal);
      const prepared = plan(await load(r, id), args, asset);
      op = { operationId: args.operationId, subject: r.subject, documentId: id, request, requestHash, ...prepared, createdAt: clock(), state: 'proposed' };
      if (!await store.images.reserve(op)) { const prior = await store.images.get(args.operationId); if (!prior) throw imageError('conflict'); return insert(input, signal, approve); }
    }
    if (args.preview || op.state !== 'proposed') return receipt(op, { writeAttempted: false, proposal: op.proposal });
    if (clock() - op.createdAt >= 600000) { await save(op, 'expired'); return receipt(op, { writeAttempted: false }); }
    if (!await store.images.claim(op)) throw imageError('busy');
    active.add(op.operationId); op.state = 'reviewing'; let stage = 'preflight';
    try {
      signal?.throwIfAborted();
      const writer = await docs.prepareWrite(r);
      stage = 'approval'; let ownerApproved = false;
      if (await needsApproval()) {
        const decision = docsApprovalDecision(await approve({ ...op.proposal, account: r.email, operationId: op.operationId }, signal));
        if (decision.outcome !== 'approved') { diagnoseDocsApproval(diagnose, decision); await save(op, decision.outcome); return receipt(op, { writeAttempted: false, reason: decision.reason }); }
        ownerApproved = true;
      }
      stage = 'revalidate';
      const current = await record(args.account); if (current.subject !== r.subject) throw docsError('authorization_failed');
      const asset = await assets.inspect(args.uri, signal), fresh = plan(await load(current, id), args, asset);
      if (fresh.before !== op.before || !isDeepStrictEqual(asset, op.proposal.asset) || clock() - op.createdAt >= 600000) throw imageError('stale');
      signal?.throwIfAborted();
      if (!ownerApproved && await needsApproval()) { await save(op, 'approval_required'); return receipt(op, { writeAttempted: false }); }
      op.approval = ownerApproved ? 'owner_approved' : 'disabled_in_settings';
      stage = 'reserve'; if (!await store.images.start(op)) throw imageError('stale');
      op.state = 'writing'; stage = 'write';
      const result = await writer.insertImage(args, signal, async () => {
        // Runs AFTER the adapter's final async identity/scope check, immediately
        // before its one POST. Never submit expired/no-card work after a long auth.
        const currentAccount = await record(args.account);
        if (currentAccount.subject !== op.subject || !await store.images.writing(op)) throw imageError('stale');
        if (!ownerApproved && await needsApproval()) throw imageError('approval_required');
        signal?.throwIfAborted();
        if (clock() - op.createdAt >= 600000) throw imageError('stale');
      });
      stage = 'verify';
      const revision = result?.writeControl?.requiredRevisionId, key = result?.replies?.[0]?.insertInlineImage?.objectId;
      const acknowledged = result?.documentId === id && Array.isArray(result?.replies) && result.replies.length === 1 && typeof revision === 'string' && revision.length > 0 && revision.length <= 2048 && typeof key === 'string' && key.length > 0 && key.length <= 256;
      op.appliedRevision = acknowledged ? revision : null; op.objectId = acknowledged ? key : null;
      await save(op, 'uncertain');
      const after = await load(current, id), readback = imageReadback(after, op);
      const verified = acknowledged && after.revisionId === op.appliedRevision && readback.matches;
      if (!verified) diagnose('docs_image_verification_mismatch', null);
      await save(op, verified ? 'verified' : 'uncertain');
      return receipt(op, { writeAttempted: true, revisionId: verified ? after.revisionId : null });
    } catch (error) {
      diagnose(`docs_image_${stage}`, error);
      const attempted = ['write', 'verify'].includes(stage), rejected = stage === 'write' && (error?.docsWriteAttempted === false || ['write_rejected', 'authorization_failed', 'scope_required', 'stale_revision'].includes(error?.docsCode));
      try { await save(op, !attempted ? 'not_submitted' : rejected ? 'rejected' : 'uncertain'); } catch (storageError) { diagnose('docs_image_receipt', storageError); }
      return receipt(op, { writeAttempted: attempted && !rejected, error: imageMessage(error) });
    } finally { active.delete(op.operationId); }
  }
  async function status(input) {
    const args = imageStatusSchema.parse(input), r = await record(args.account), op = await store.images.get(args.operationId);
    if (!op || op.subject !== r.subject) throw imageError('unknown_operation');
    if (active.has(op.operationId)) return receipt(op, { inProgress: true, writeAttempted: false });
    if (!['writing', 'uncertain', 'verified'].includes(op.state)) return receipt(op, { historical: true, writeAttempted: false });
    try {
      const after = await load(r, op.documentId), readback = imageReadback(after, op);
      const evidence = { readbackMatches: readback.matches, observedObjectId: readback.objectId || null, observedRevisionId: after.revisionId, writeAttempted: false };
      if (op.state === 'verified') return receipt(op, { ...evidence, outcome: readback.matches ? 'verified' : 'changed_since_verification' });
      if (readback.matches && op.appliedRevision && op.objectId && after.revisionId === op.appliedRevision) { await save(op, 'verified'); return receipt(op, evidence); }
      if (!readback.matches) diagnose('docs_image_recovery_mismatch', null);
      return receipt(op, { ...evidence, outcome: readback.matches ? 'observed_matching' : 'uncertain', guidance: 'Read-only observation cannot prove a lost request finished or caused this image. Original unresolved document claim is retained. Never replay or replace its key.' });
    } catch (error) { diagnose('docs_image_recovery', error); return receipt(op, { outcome: 'verification_unavailable', writeAttempted: false }); }
  }
  return { inspect, insert, status };
}
