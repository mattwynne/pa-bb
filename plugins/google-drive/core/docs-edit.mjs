// Narrow Docs port: complete inspection, one literal replacement, owner policy.
// No arbitrary request objects or index-based editing escape this boundary.
import { docsApprovalDecision, docsApprovalReceipt, diagnoseDocsApproval } from './docs-approval.mjs';
export const DOC_LIMIT = 50_000; // UTF-16 code units across every tab
export const EDIT_LIMIT = 2_000;
const MESSAGES = Object.freeze({
  invalid_input: 'Use an explicit connected account, Google Docs URL/ID, tab ID, revision and bounded nonempty old text. Replacement text may be empty. Use one text run, without line breaks or control characters.',
  unknown_account: 'Unknown Google Drive account. Check connected accounts in BB settings.',
  wrong_type: 'This file is not an available Google Doc.',
  unsupported_document: 'Editing requires a complete, bounded, suggestion-free document containing only ordinary text paragraphs in every tab. Tables, headers, footers, footnotes, objects and other structures are not supported.',
  stale_revision: 'The document revision changed. Inspect it again and prepare a new replacement; nothing was written.',
  match_not_unique: 'Old text must match exactly once in the selected tab and fit within one text run. Nothing was written.',
  scope_required: 'This account lacks an owner-authorized Docs write grant. Existing read-only connections cannot edit. Use supported Settings reauthorization only when a write-consent flow has been delivered and approved by the account owner; reconnecting to a read-only flow will not help. Never handle tokens manually.',
  write_rejected: 'Google rejected the required revision or replacement. Inspect the document again; nothing was written.',
  authorization_failed: 'Google rejected access. Check the selected account, document edit permission and authorized scopes in Settings.',
  remote_unavailable: 'Google Docs inspection or authorization is unavailable. No write was attempted.',
  image_operation_busy: 'An image operation is reviewing, writing or unresolved on this document. Recover it with gdocs_image_status and its original account/key before another edit.',
  approval_policy_unavailable: 'The Google Docs approval setting could not be checked. No write was attempted. Check plugin Settings and try again.',
});
export function docsError(code) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.remote_unavailable), { docsCode: code }); }
export function docsErrorMessage(error) { return MESSAGES[error?.docsCode] || MESSAGES.remote_unavailable; }
export function docsFailureCategory(error) { return Object.hasOwn(MESSAGES, error?.docsCode) ? error.docsCode : 'unknown'; }
const nonempty = (s, max = 256) => typeof s === 'string' && s.length > 0 && s.length <= max;
export function documentId(input) {
  if (!nonempty(input, 1024)) throw docsError('invalid_input');
  let id = input;
  if (input.startsWith('https://')) {
    let url;
    try { url = new URL(input); } catch { throw docsError('invalid_input'); }
    if (url.origin !== 'https://docs.google.com' || url.username || url.password) throw docsError('invalid_input');
    id = /^\/document\/d\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1];
  }
  if (!nonempty(id) || !/^[\w-]+$/.test(id)) throw docsError('invalid_input');
  return id;
}
const populated = value => value != null && (typeof value !== 'object' || Object.keys(value).length > 0);
export function rejectSuggestions(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key.startsWith('suggested') || key === 'suggestions') && populated(child)) throw docsError('unsupported_document');
    rejectSuggestions(child);
  }
}
// Exact contiguous UTF-16 coverage, not the lossy text projection of gdocs_read.
// JS string.length and Google Docs indices both count UTF-16 code units.
export function inspectDocument(doc, id) {
  const fail = () => { throw docsError('unsupported_document'); };
  if (doc?.documentId !== id || !nonempty(doc.revisionId, 2048) || doc.suggestionsViewMode !== 'SUGGESTIONS_INLINE' || !Array.isArray(doc.tabs) || !doc.tabs.length) fail();
  rejectSuggestions(doc);
  for (const key of ['body', 'headers', 'footers', 'footnotes', 'inlineObjects', 'positionedObjects']) if (populated(doc[key])) fail();
  const tabs = [];
  let size = 0;
  function visit(nodes, depth = 0) {
    if (depth > 16 || !Array.isArray(nodes)) fail();
    for (const tab of nodes) {
      if (!tab || typeof tab !== 'object' || Array.isArray(tab)) fail();
      const tabId = tab?.tabProperties?.tabId;
      if (Object.keys(tab).some(key => !['documentTab', 'tabProperties', 'childTabs'].includes(key))) fail();
      if (!nonempty(tabId) || tabs.some(t => t.tabId === tabId) || tabs.length >= 16 || !tab.documentTab) fail();
      const data = tab.documentTab;
      if (Object.keys(data).some(key => !['body', 'headers', 'footers', 'footnotes', 'inlineObjects', 'positionedObjects', 'documentStyle', 'namedStyles', 'lists', 'namedRanges', 'suggestedDocumentStyleChanges', 'suggestedNamedStylesChanges', 'commentAnchors', 'dropdownDefinitions'].includes(key))) fail();
      for (const key of ['headers', 'footers', 'footnotes', 'inlineObjects', 'positionedObjects', 'commentAnchors', 'dropdownDefinitions']) if (populated(data[key])) fail();
      if (data.body && Object.keys(data.body).some(key => key !== 'content')) fail();
      if (!Array.isArray(data.body?.content) || data.body.content.length < 2) fail();
      const runs = [];
      let text = '', index = 0;
      for (const item of data.body.content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail();
        if (Object.keys(item).some(key => !['startIndex', 'endIndex', 'paragraph', 'sectionBreak'].includes(key))) fail();
        const start = item.startIndex ?? 0;
        if (start !== index || !Number.isInteger(item.endIndex)) fail();
        if (item.sectionBreak && index === 0 && item.endIndex === 1 && !item.paragraph && !item.table && !item.tableOfContents) { index = 1; continue; }
        if (!item.paragraph || item.table || item.tableOfContents || item.sectionBreak || !Array.isArray(item.paragraph.elements) || !item.paragraph.elements.length || populated(item.paragraph.positionedObjectIds)) fail();
        let paragraph = '';
        for (const part of item.paragraph.elements) {
          if (!part || typeof part !== 'object' || Array.isArray(part)) fail();
          if (Object.keys(part).some(key => !['startIndex', 'endIndex', 'textRun'].includes(key)) || typeof part.textRun?.content !== 'string' || !part.textRun.content.length || Object.keys(part.textRun).some(key => !['content', 'textStyle', 'suggestedTextStyleChanges', 'suggestedInsertionIds', 'suggestedDeletionIds'].includes(key)) || part.startIndex !== index || part.endIndex !== index + part.textRun.content.length || !part.textRun.content.isWellFormed()) fail();
          runs.push({ offset: text.length, text: part.textRun.content });
          paragraph += part.textRun.content;
          text += part.textRun.content;
          size += part.textRun.content.length;
          if (size > DOC_LIMIT) fail();
          index = part.endIndex;
        }
        if (!paragraph.endsWith('\n') || paragraph.slice(0, -1).includes('\n') || item.endIndex !== index) fail();
      }
      if (!text.endsWith('\n')) fail();
      tabs.push({ tabId, title: String(tab.tabProperties.title || '').slice(0, 256), text, runs });
      if (tab.childTabs !== undefined) visit(tab.childTabs, depth + 1);
    }
  }
  visit(doc.tabs);
  return { documentId: id, revisionId: doc.revisionId, title: String(doc.title || '').slice(0, 500), tabs };
}
function replacement(snapshot, args) {
  const { expectedRevisionId, tabId, oldText, newText } = args;
  const validText = s => typeof s === 'string' && s.length <= EDIT_LIMIT && s.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\uE000-\uF8FF\u2028\u2029]/u.test(s);
  if (!nonempty(expectedRevisionId, 2048) || !nonempty(tabId) || !validText(oldText) || !oldText.length || !validText(newText) || oldText === newText || (args.preview !== undefined && typeof args.preview !== 'boolean')) throw docsError('invalid_input');
  if (snapshot.revisionId !== expectedRevisionId) throw docsError('stale_revision');
  const tab = snapshot.tabs.find(t => t.tabId === tabId);
  const offset = tab?.text.indexOf(oldText) ?? -1;
  // Count overlapping occurrences too: do not rely on Google's match iteration.
  if (!tab || offset < 0 || tab.text.indexOf(oldText, offset + 1) !== -1 || !tab.runs.some(run => offset >= run.offset && offset + oldText.length <= run.offset + run.text.length)) throw docsError('match_not_unique');
  if (snapshot.tabs.reduce((n, t) => n + t.text.length, 0) - oldText.length + newText.length > DOC_LIMIT) throw docsError('invalid_input');
  return { tab, offset };
}
export function createDocsEditService({ store, drive, docs, diagnose = (_stage, _error) => {}, approve = async (_proposal) => /** @type {unknown} */ ({ outcome: 'cancelled', reason: 'request-aborted' }), approvalRequired = async () => true }) {
  async function needsApproval() {
    try { return (await approvalRequired()) !== false; }
    catch { throw docsError('approval_policy_unavailable'); }
  }
  async function load(args) {
    if (!nonempty(args.account, 320)) throw docsError('invalid_input');
    const record = await store.byEmail(args.account);
    if (!record) throw docsError('unknown_account');
    const id = documentId(args.document);
    const metadata = await drive.getFile(record, id);
    if (metadata.id !== id || metadata.trashed !== false || metadata.mimeType !== 'application/vnd.google-apps.document') throw docsError('wrong_type');
    return { record, snapshot: inspectDocument(await docs.inspect(record, id), id) };
  }
  async function inspect(args) {
    const { record, snapshot } = await load(args);
    return { account: record.email, ...snapshot, complete: true, tabs: snapshot.tabs.map(({ runs, ...tab }) => tab) };
  }
  async function replace(args, signal) {
    const { record, snapshot } = await load(args);
    if (await store.images?.active(snapshot.documentId)) throw docsError('image_operation_busy');
    const { tab, offset } = replacement(snapshot, args);
    const proposal = { account: record.email, documentId: snapshot.documentId, title: snapshot.title,
      tabId: tab.tabId, tabTitle: tab.title, expectedRevisionId: snapshot.revisionId, oldText: args.oldText, newText: args.newText };
    if (args.preview !== false) return { outcome: 'preview', writeAttempted: false, writeAuthorization: 'not_checked', proposal };
    // Obtain a same-account, scope-checked writer BEFORE requesting consent.
    // No tokens or arbitrary request proxy leave the adapter.
    const writer = await docs.prepareWrite(record);
    const stop = decision => {
      diagnoseDocsApproval(diagnose, decision);
      return docsApprovalReceipt(decision);
    };
    if (signal?.aborted) return stop({ outcome: 'cancelled', reason: 'caller_aborted' });
    let ownerApproved = false;
    if (await needsApproval()) {
      let decision;
      try { decision = docsApprovalDecision(await approve(proposal)); }
      catch { return stop(signal?.aborted ? { outcome: 'cancelled', reason: 'caller_aborted' } : { outcome: 'approval_unavailable', reason: 'request_failed' }); }
      if (decision.outcome !== 'approved') return stop(decision);
      ownerApproved = true;
    }
    if (signal?.aborted) return stop({ outcome: 'cancelled', reason: 'caller_aborted' });
    // No-card writes use explicit standing consent in Settings, not a forged
    // owner submission. Re-inspect in both modes, then close the remaining race
    // with requiredRevisionId in the single atomic provider request.
    const current = await load(args);
    if (await store.images?.active(snapshot.documentId)) throw docsError('image_operation_busy');
    if (current.record.subject !== record.subject) throw docsError('authorization_failed');
    replacement(current.snapshot, args);
    // Recheck policy after inspection, before entering provider submission.
    // A form already open still needs its own explicit choice.
    if (!ownerApproved && await needsApproval()) return { outcome: 'approval_required', writeAttempted: false,
      guidance: 'Per-edit approval was re-enabled while this edit was preparing. No write was attempted. Request a fresh review.' };
    const approval = ownerApproved ? 'owner_approved' : 'disabled_in_settings';
    if (signal?.aborted) return stop({ outcome: 'cancelled', reason: 'caller_aborted' });
    let response;
    try { response = await writer.replace(proposal, signal); }
    catch (error) {
      // Only the adapter can establish a definitive rejection before application.
      if (error?.docsWriteAttempted === false || ['authorization_failed', 'write_rejected', 'scope_required', 'stale_revision'].includes(error?.docsCode)) throw error;
      diagnose('docs_write_uncertain', error);
      return { outcome: 'uncertain', writeAttempted: true, approval, retrySafe: false, guidance: 'Inspect the document before deciding what to do. Never replay this replacement blindly.' };
    }
    try {
      if (response?.documentId !== snapshot.documentId || response.replies?.length !== 1 || response.replies[0]?.replaceAllText?.occurrencesChanged !== 1 || !nonempty(response.writeControl?.requiredRevisionId, 2048)) throw docsError('unsupported_document');
      const after = (await load(args)).snapshot;
      if (after.revisionId !== response.writeControl.requiredRevisionId || after.tabs.length !== snapshot.tabs.length || after.tabs.some((t, i) => t.tabId !== snapshot.tabs[i].tabId || t.text !== (t.tabId === tab.tabId ? tab.text.slice(0, offset) + args.newText + tab.text.slice(offset + args.oldText.length) : snapshot.tabs[i].text))) throw docsError('unsupported_document');
      return { outcome: 'verified', writeAttempted: true, approval, documentId: snapshot.documentId, tabId: tab.tabId, revisionId: after.revisionId, replacements: 1, verification: 'All tab body text matches the expected single replacement. Formatting is not independently verified.' };
    } catch (error) {
      diagnose('docs_write_verification', error);
      return { outcome: 'verification_unavailable', writeAttempted: true, approval, retrySafe: false, guidance: 'Google returned a result, but the exact post-write document could not be verified. Inspect it; do not replay the replacement.' };
    }
  }
  return { inspect, replace };
}
