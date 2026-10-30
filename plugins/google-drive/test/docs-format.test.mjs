import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createDocsFormatService, inspectFormatting, formatRequests, formattingReadbackMatches } from '../core/docs-format.mjs';
import { document, tab, account, record } from './docs-fixtures.mjs';
const key = '11111111-1111-4111-8111-111111111111', key2 = '22222222-2222-4222-8222-222222222222';
export function formatDoc() {
  const d = document('Title 😀\n');
  const t = d.tabs[0].documentTab;
  const start = t.body.content.at(-1).endIndex;
  t.body.content.push({ startIndex: start, endIndex: start + 5, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ startIndex: start, endIndex: start + 5, textRun: { content: 'Body\n' } }] } });
  t.documentStyle = { documentFormat: { documentMode: 'PAGES' }, pageSize: { width: { magnitude: 595, unit: 'PT' }, height: { magnitude: 842, unit: 'PT' } } };
  t.namedStyles = { styles: [{ namedStyleType: 'NORMAL_TEXT', textStyle: { bold: false, fontSize: { magnitude: 11, unit: 'PT' }, weightedFontFamily: { fontFamily: 'Arial', weight: 400 } }, paragraphStyle: { lineSpacing: 100 } }] };
  d.tabs[0].childTabs = [tab('Other tab\n', 'tab-b')];
  return d;
}
export const args = () => ({ account, document: 'doc-a', operationId: key, expectedRevisionId: 'rev-a', ranges: [{ tabId: 'tab-a', startIndex: 1, endIndex: 10,
  textStyle: { fontFamily: 'Inter', sizePt: 30, bold: true, foregroundColor: '#17221C' }, paragraphStyle: { spaceAbovePt: 18, spaceBelowPt: 6, lineSpacing: 120 } }],
  page: { tabId: 'tab-a', size: 'LETTER', marginTopPt: 61.2, marginBottomPt: 61.2, marginLeftPt: 61.2, marginRightPt: 61.2 } });
// Independent fixture provider implementing only the documented typed requests.
export function applyRequests(doc, requests) {
  const all = [doc.tabs[0], ...doc.tabs[0].childTabs];
  for (const request of requests) {
    if (request.updateDocumentStyle) {
      const q = request.updateDocumentStyle;
      assert.equal(q.fields, Object.keys(q.documentStyle).join(','));
      if (q.documentStyle.pageSize) assert.deepEqual(q.documentStyle.pageSize, { width: { magnitude: 612, unit: 'PT' }, height: { magnitude: 792, unit: 'PT' } });
      Object.assign(all.find(t => t.tabProperties.tabId === q.tabId).documentTab.documentStyle, q.documentStyle);
    } else {
      const q = request.updateTextStyle || request.updateParagraphStyle;
      assert.ok(q.range.tabId); assert.equal(q.range.segmentId, undefined); assert.doesNotMatch(q.fields, /\*/);
      const t = all.find(t => t.tabProperties.tabId === q.range.tabId);
      for (const p of t.documentTab.body.content.filter(x => x.paragraph && x.startIndex >= q.range.startIndex && x.endIndex <= q.range.endIndex)) {
        if (q.paragraphStyle) Object.assign(p.paragraph.paragraphStyle ||= {}, q.paragraphStyle);
        else for (const e of p.paragraph.elements) {
          const oldFamily = e.textRun.textStyle?.weightedFontFamily || {};
          Object.assign(e.textRun.textStyle ||= {}, q.textStyle);
          if (q.textStyle.weightedFontFamily) e.textRun.textStyle.weightedFontFamily = { ...oldFamily, ...q.textStyle.weightedFontFamily };
        }
      }
    }
  }
  doc.revisionId = 'rev-b'; return doc;
}
async function setup(options = {}) {
  const h = createFakePluginHost({ pluginId: 'format-tests' });
  const store = createBbStore(h.bb.storage.database(), h.bb.storage.migrate);
  await store.addAccount({ ...record, refreshToken: 'synthetic-refresh' });
  let doc = formatDoc(), writes = 0, approvals = 0, reads = 0;
  const logs = [];
  const docs = { inspect: async () => { reads++; if (options.readFailure?.(reads, writes)) throw new Error('private-provider-content'); return structuredClone(doc); },
    prepareWrite: async () => {
      if (options.scopeFailure) throw Object.assign(new Error('private-token'), { docsCode: 'scope_required' });
      return { format: async (p, signal) => {
        writes++; assert.equal(p.expectedRevisionId, 'rev-a');
        if (options.rejected) throw Object.assign(new Error('private-rejected'), { docsCode: 'write_rejected' });
        const requests = formatRequests(p);
        if (!options.noApply) doc = applyRequests(doc, requests);
        options.afterWrite?.(doc);
        if (options.lost) throw new Error('private-token-provider-body');
        return options.malformed ? {} : { documentId: 'doc-a', replies: requests.map(() => ({})), writeControl: { requiredRevisionId: 'rev-b' } };
      } };
    } };
  const ports = { store, docs, drive: { getFile: async () => ({ id: 'doc-a', mimeType: 'application/vnd.google-apps.document', trashed: false }) },
    approve: async p => { approvals++; await options.approval?.(p, doc); return options.decision || { outcome: 'submitted', value: { approved: true } }; },
    diagnose: (stage, error) => logs.push(stage), clock: options.clock, approvalRequired: options.approvalRequired };
  return { h, store, ports, get doc() { return doc; }, get writes() { return writes; }, get approvals() { return approvals; }, logs,
    service: createDocsFormatService(ports), close: () => h.harness.lifecycle.dispose() };
}
test('inspection returns exact UTF-16 ranges and raw styles; requests are tab scoped and narrow', async () => {
  const h = await setup();
  try {
    const inspected = await h.service.inspect({ account, document: 'doc-a' });
    assert.equal(inspected.complete, true); assert.equal(inspected.paragraphs[0].text, 'Title 😀\n'); assert.equal(inspected.paragraphs[0].endIndex, 10);
    assert.equal(inspected.tabs.length, 2); assert.equal(inspected.tabStyles[0].namedStyles.styles[0].namedStyleType, 'NORMAL_TEXT');
    assert.match(inspected.inheritance, /Missing values inherit/);
    const preview = await h.service.format(args()); assert.equal(preview.outcome, 'proposed'); assert.equal(h.writes, 0); assert.equal(h.approvals, 0);
    const a = args(), requests = formatRequests(a);
    assert.equal(requests[1].updateTextStyle.fields, 'weightedFontFamily.fontFamily,fontSize,bold,foregroundColor');
    assert.equal(requests[2].updateDocumentStyle.tabId, 'tab-a');
    assert.equal(requests[0].updateParagraphStyle.paragraphStyle.lineSpacing, 120);
    assert.equal(preview.proposal.selections[0].paragraphs[0].text, 'Title 😀\n');
  } finally { await h.close(); }
});
test('opaque page colour has the documented nested shape, exact tab/mask and preserves all omitted layout/text', async () => {
  const h = await setup();
  try {
    Object.assign(h.doc.tabs[0].documentTab.documentStyle, { marginLeft: { magnitude: 54, unit: 'PT' }, marginRight: { magnitude: 63, unit: 'PT' }, background: { color: {} }, flipPageOrientation: true });
    const before = structuredClone(h.doc);
    const a = { ...args(), ranges: [], page: { tabId: 'tab-a', backgroundColor: '#F4F1E8' } };
    const expectedBackground = { color: { color: { rgbColor: { red: 244 / 255, green: 241 / 255, blue: 232 / 255 } } } };
    assert.deepEqual(formatRequests(a), [{ updateDocumentStyle: { tabId: 'tab-a', documentStyle: { background: expectedBackground }, fields: 'background' } }]);
    const preview = await h.service.format(a); assert.equal(h.writes, 0);
    assert.deepEqual(preview.proposal.page.after, a.page); assert.deepEqual(preview.proposal.selections, []);
    const result = await h.service.format({ ...a, preview: false }); assert.equal(result.outcome, 'verified'); assert.equal(h.approvals, 1);
    const expected = structuredClone(before); expected.revisionId = 'rev-b'; expected.tabs[0].documentTab.documentStyle.background = expectedBackground;
    assert.deepEqual(h.doc, expected);
    assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'verified'); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('individual margin and combined colour/layout use only the requested page fields', async () => {
  const h = await setup();
  try {
    const a = { ...args(), ranges: [], page: { tabId: 'tab-a', marginLeftPt: 61.2, backgroundColor: '#000000' } };
    assert.equal(formatRequests(a)[0].updateDocumentStyle.fields, 'marginLeft,background');
    assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'verified');
    assert.equal(h.doc.tabs[0].documentTab.documentStyle.pageSize.width.magnitude, 595);
    const all = args(); all.page.backgroundColor = '#FFFFFF';
    assert.equal(formatRequests(all).at(-1).updateDocumentStyle.fields, 'pageSize,marginTop,marginBottom,marginLeft,marginRight,background');
  } finally { await h.close(); }
});
test('background rejects empty/alpha/named/raw/shading requests, wrong tabs and unsupported layout before writes', async () => {
  const h = await setup();
  try {
    for (const page of [{ tabId: 'tab-a' }, { tabId: 'tab-a', backgroundColor: undefined }, { tabId: 'tab-a', backgroundColor: '#F4F1E880' },
      { tabId: 'tab-a', backgroundColor: 'paper' }, { backgroundColor: '#F4F1E8' }, { tabId: 'tab-b', backgroundColor: '#F4F1E8' },
      { tabId: 'tab-a', backgroundColor: '#F4F1E8', color: {} }, { tabId: 'tab-a', backgroundColor: { red: 1 } }]) {
      await assert.rejects(h.service.format({ ...args(), ranges: [], page }));
    }
    const a = args(); a.ranges[0].paragraphStyle.backgroundColor = '#F4F1E8'; await assert.rejects(h.service.format(a));
    h.doc.tabs[0].documentTab.documentStyle.background = { color: {}, futureField: true };
    await assert.rejects(h.service.format({ ...args(), ranges: [], page: { tabId: 'tab-a', backgroundColor: '#F4F1E8' } }));
    delete h.doc.tabs[0].documentTab.documentStyle.background; h.doc.tabs[0].documentTab.documentStyle.documentFormat.documentMode = 'PAGELESS';
    await assert.rejects(h.service.format({ ...args(), ranges: [], page: { tabId: 'tab-a', backgroundColor: '#F4F1E8' } }));
    assert.equal(h.writes, 0); assert.equal(h.approvals, 0);
  } finally { await h.close(); }
});
test('background readback detects wrong colour or unrelated layout changes; lost responses never gain success', async () => {
  const colour = () => ({ ...args(), ranges: [], page: { tabId: 'tab-a', backgroundColor: '#F4F1E8' } });
  for (const mutate of [d => { d.tabs[0].documentTab.documentStyle.background.color.color.rgbColor.red = 0.5; },
    d => { d.tabs[0].documentTab.documentStyle.marginLeft = { magnitude: 40, unit: 'PT' }; }]) {
    const h = await setup({ afterWrite: mutate });
    try { assert.equal((await h.service.format({ ...colour(), preview: false })).outcome, 'uncertain'); assert.equal(h.writes, 1); }
    finally { await h.close(); }
  }
  const h = await setup({ lost: true });
  try {
    assert.equal((await h.service.format({ ...colour(), preview: false })).outcome, 'uncertain');
    const r = await h.service.status({ account, operationId: key });
    assert.equal(r.outcome, 'observed_matching'); assert.equal(r.providerAcknowledged, false); assert.equal(h.writes, 1);
    assert.equal((await h.store.getFormatting(key)).state, 'uncertain');
  } finally { await h.close(); }
});
test('mandatory approval, atomic batch and exact all-tab API style/text verification; repeated keys never write', async () => {
  const h = await setup();
  try {
    await h.service.format(args());
    const result = await h.service.format({ ...args(), preview: false });
    assert.equal(result.outcome, 'verified'); assert.equal(h.writes, 1); assert.equal(h.approvals, 1);
    assert.equal(h.doc.tabs[0].childTabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold, true);
    assert.equal((await h.service.format({ ...args(), preview: false })).outcome, 'verified'); assert.equal(h.writes, 1);
    assert.equal((await h.service.status({ account, operationId: key })).outcome, 'verified');
    assert.equal(h.logs.length, 0);
    await assert.rejects(h.service.format({ ...args(), ranges: [], page: { ...args().page, marginLeftPt: 62 } }), /another request/);
  } finally { await h.close(); }
});
test('decline, timeout and invalid approval never write; scope preflight occurs before approval', async () => {
  for (const decision of [{ outcome: 'submitted', value: { approved: false } }, { outcome: 'cancelled', reason: 'timeout' }, { outcome: 'submitted', value: { approved: 'true' } }]) {
    const h = await setup({ decision });
    try { const r = await h.service.format({ ...args(), preview: false }); assert.equal(r.writeAttempted, false); assert.equal(h.writes, 0); assert.notEqual(r.outcome, 'verified'); }
    finally { await h.close(); }
  }
  const h = await setup({ scopeFailure: true });
  try { assert.equal((await h.service.format({ ...args(), preview: false })).outcome, 'not_submitted'); assert.equal(h.approvals, 0); assert.equal(h.writes, 0); }
  finally { await h.close(); }
});
test('owner optout skips only the card; policy errors, re-enabling and read-only grants fail closed', async () => {
  let h = await setup({ approvalRequired: async () => false });
  try {
    assert.equal((await h.service.format(args())).approval, 'not_checked'); assert.equal(h.writes, 0);
    const result = await h.service.format({ ...args(), preview: false });
    assert.equal(result.outcome, 'verified'); assert.equal(result.approval, 'disabled_in_settings'); assert.equal(h.approvals, 0); assert.equal(h.writes, 1);
  } finally { await h.close(); }
  for (const policy of [async () => { throw new Error('private-policy-secret'); }, (() => { let checks = 0; return async () => ++checks > 1; })()]) {
    h = await setup({ approvalRequired: policy });
    try { const r = await h.service.format({ ...args(), preview: false }); assert.equal(r.writeAttempted, false); assert.equal(h.writes, 0); assert.equal(h.approvals, 0); }
    finally { await h.close(); }
  }
  h = await setup({ approvalRequired: async () => false, scopeFailure: true });
  try { assert.equal((await h.service.format({ ...args(), preview: false })).writeAttempted, false); assert.equal(h.writes, 0); }
  finally { await h.close(); }
});
test('disabling policy does not auto-approve a card already open', async () => {
  let required = true;
  const h = await setup({ approvalRequired: async () => required });
  try {
    const result = await h.service.format({ ...args(), preview: false }, undefined, async () => { required = false; return { outcome: 'submitted', value: { approved: false } }; });
    assert.equal(result.outcome, 'declined'); assert.equal(h.writes, 0);
  } finally { await h.close(); }
});
test('stale revisions, mid-approval changes, expiry and abort fail closed', async () => {
  let now = 0;
  for (const mode of ['stale', 'approval', 'expiry', 'abort']) {
    const h = await setup({ clock: () => now, approval: async (_p, doc) => { if (mode === 'approval') doc.revisionId = 'other'; } });
    try {
      const a = args(); if (mode === 'stale') a.expectedRevisionId = 'old';
      if (mode === 'stale') await assert.rejects(h.service.format(a), /revision/);
      else {
        await h.service.format(a); if (mode === 'expiry') now += 600_000;
        const controller = new AbortController(); if (mode === 'abort') controller.abort();
        const result = await h.service.format({ ...a, preview: false }, controller.signal);
        assert.equal(result.writeAttempted, false); assert.equal(h.writes, 0);
      }
    } finally { await h.close(); }
  }
});
test('ranges reject overlaps, partial paragraphs/surrogate cuts, wrong tabs, oversized selections and raw passthrough', async () => {
  const h = await setup();
  try {
    for (const change of [a => a.ranges.push(a.ranges[0]), a => a.ranges[0].endIndex--, a => a.ranges[0].startIndex = 8,
      a => a.ranges[0].tabId = 'missing', a => a.ranges[0].textStyle.raw = {}, a => a.ranges[0].paragraphStyle.namedStyleType = 'HEADING_1',
      a => a.requests = [], a => a.page.tabId = 'tab-b', a => a.page.marginLeftPt = -1, a => a.ranges[0].textStyle.foregroundColor = 'red']) {
      const a = args(); change(a); await assert.rejects(h.service.format(a));
    }
    const a = args(); a.ranges = []; a.page = undefined; await assert.rejects(h.service.format(a)); assert.equal(h.writes, 0);
    const doc = document('x'.repeat(8001) + '\n'); h.ports.docs.inspect = async () => doc;
    const long = args(); long.page = undefined; long.ranges[0].endIndex = 8003; await assert.rejects(h.service.format(long));
  } finally { await h.close(); }
});
test('unsupported structures fail closed including other tabs, section overrides and pageless layout', () => {
  for (const mutate of [d => d.tabs[0].documentTab.body.content[1].paragraph.bullet = {}, d => d.tabs[0].documentTab.documentStyle.documentFormat.documentMode = 'PAGELESS',
    d => d.tabs[0].documentTab.body.content[0].sectionBreak.sectionStyle = { marginLeft: { magnitude: 20, unit: 'PT' } },
    d => d.tabs[0].childTabs[0].documentTab.headers = { private: {} }, d => d.tabs[0].childTabs[0].documentTab.body.content.push({ table: {} }),
    d => d.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.suggestedInsertionIds = ['private']]) {
    const doc = formatDoc(); mutate(doc); assert.throws(() => inspectFormatting(doc, 'doc-a'));
  }
});
test('preserves unrelated styles/content, with conservative mismatch on any unexpected change', async () => {
  for (const mutate of [d => d.tabs[0].childTabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.italic = true,
    d => d.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.content = 'Oops\n',
    d => d.tabs[0].documentTab.namedStyles.styles[0].textStyle.bold = true,
    d => d.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.textStyle = { bold: false }, // unrelated explicit override is not normalized away
    d => d.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.fontSize.magnitude = 29]) {
    const h = await setup({ afterWrite: mutate });
    try { const r = await h.service.format({ ...args(), preview: false }); assert.equal(r.outcome, 'uncertain'); assert.equal(h.writes, 1); assert.ok(h.logs.includes('docs_format_verification_mismatch')); }
    finally { await h.close(); }
  }
});
test('canonical comparison accepts run splits and known inherited style readback, without guessing defaults', async () => {
  const h = await setup({ afterWrite: d => {
    const p = d.tabs[0].documentTab.body.content[1].paragraph;
    const e = p.elements[0], copy = structuredClone(e);
    e.endIndex = 4; e.textRun.content = 'Tit'; copy.startIndex = 4; copy.textRun.content = 'le 😀\n'; p.elements.push(copy);
    for (const e of p.elements) delete e.textRun.textStyle.bold; // requested false matches the known named parent
  } });
  try { const a = args(); a.ranges[0].textStyle.bold = false; assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'verified'); }
  finally { await h.close(); }
});
test('zero RGB/dimension scalar omission is accepted, but unrequested inherited font weight must be preserved', async () => {
  let h = await setup({ afterWrite: d => {
    const p = d.tabs[0].documentTab.body.content[1].paragraph;
    p.paragraphStyle.spaceAbove = { unit: 'PT' };
    p.elements[0].textRun.textStyle.foregroundColor.color.rgbColor = {};
  } });
  try {
    const a = args(); a.ranges[0].textStyle.foregroundColor = '#000000'; a.ranges[0].paragraphStyle.spaceAbovePt = 0;
    assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'verified');
  } finally { await h.close(); }
  h = await setup();
  try {
    h.doc.tabs[0].documentTab.namedStyles.styles[0].textStyle.weightedFontFamily.weight = 500;
    const p = h.doc.tabs[0].documentTab.body.content[1].paragraph;
    delete p.elements[0].textRun.textStyle.weightedFontFamily;
    // Fixture provider defaults changed font family to 400: this side effect is
    // NOT permission to discard the inherited 500 weight.
    assert.equal((await h.service.format({ ...args(), preview: false })).outcome, 'uncertain');
  } finally { await h.close(); }
});
test('selected line spacing accepts one float32 bin, without mutating saved expectations', async () => {
  const h = await setup({ afterWrite: d => { d.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle.lineSpacing = 120.00001; } });
  try {
    const r = await h.service.format({ ...args(), preview: false });
    assert.equal(r.outcome, 'verified'); assert.equal(r.providerAcknowledged, true); assert.equal(r.appliedRevisionId, 'rev-b');
    const op = await h.store.getFormatting(key), saved = JSON.stringify(op.expected);
    assert.equal(formattingReadbackMatches(h.doc, op), true); assert.equal(JSON.stringify(op.expected), saved);
  } finally { await h.close(); }
});
test('float32 accommodation cannot conceal real spacing, unselected, font, margin, named-style or text changes', async () => {
  for (const mutate of [
    d => { d.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle.lineSpacing = 120.0001; },
    d => { d.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle.lineSpacing = 100.00001; },
    d => { d.tabs[0].documentTab.namedStyles.styles[0].paragraphStyle.lineSpacing = 100.00001; },
    d => { d.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.fontSize.magnitude += 0.00001; },
    d => { d.tabs[0].documentTab.documentStyle.marginLeft.magnitude += 0.00001; },
    d => { d.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content = 'Other 😀\n'; },
  ]) {
    const h = await setup({ afterWrite: d => { d.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle.lineSpacing = 120.00001; mutate(d); } });
    try { const r = await h.service.format({ ...args(), preview: false }); assert.equal(r.outcome, 'uncertain'); assert.equal(r.providerAcknowledged, true); }
    finally { await h.close(); }
  }
  const h = await setup();
  try { const a = args(); a.ranges[0].paragraphStyle.lineSpacing = 120.00001; await assert.rejects(h.service.format(a)); assert.equal(h.writes, 0); }
  finally { await h.close(); }
});
test('float32 recovery still distinguishes saved acknowledgment, lost responses and later revisions', async () => {
  for (const lost of [false, true]) {
    const h = await setup({ lost, readFailure: (_reads, writes) => writes > 0,
      afterWrite: d => { d.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle.lineSpacing = 120.00001; } });
    try {
      assert.equal((await h.service.format({ ...args(), preview: false })).outcome, 'uncertain');
      h.ports.docs.inspect = async () => structuredClone(h.doc);
      const status = await createDocsFormatService(h.ports).status({ account, operationId: key });
      assert.equal(status.outcome, lost ? 'observed_matching' : 'verified'); assert.equal(status.writeAttempted, false);
      assert.equal(status.providerAcknowledged, !lost); assert.equal(status.responseRevisionMatchesReadback, !lost); assert.equal(h.writes, 1);
      if (lost) assert.equal((await h.store.getFormatting(key)).state, 'uncertain');
    } finally { await h.close(); }
  }
  const h = await setup({ readFailure: (_reads, writes) => writes > 0,
    afterWrite: d => { d.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle.lineSpacing = 120.00001; } });
  try {
    await h.service.format({ ...args(), preview: false }); h.doc.revisionId = 'later'; h.ports.docs.inspect = async () => structuredClone(h.doc);
    const r = await h.service.status({ account, operationId: key });
    assert.equal(r.outcome, 'observed_matching'); assert.equal(r.providerAcknowledged, true); assert.equal(r.responseRevisionMatchesReadback, false);
    assert.equal((await h.store.getFormatting(key)).state, 'uncertain'); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('lost response recovery is read only and keeps unresolved cross-account document lock', async () => {
  const h = await setup({ lost: true });
  try {
    assert.equal((await h.service.format({ ...args(), preview: false })).outcome, 'uncertain');
    const restarted = createDocsFormatService(h.ports);
    const status = await restarted.status({ account, operationId: key });
    assert.equal(status.outcome, 'observed_matching'); assert.equal(status.writeAttempted, false); assert.equal(h.writes, 1);
    assert.equal((await restarted.format({ ...args(), preview: false })).outcome, 'uncertain'); assert.equal(h.writes, 1);
    await assert.rejects(restarted.format({ ...args(), operationId: key2, expectedRevisionId: 'rev-b', preview: false }), /Another formatting/);
    await h.store.addAccount({ subject: 'other', email: 'other@example.test', refreshToken: 'synthetic-other' });
    await assert.rejects(restarted.status({ account: 'other@example.test', operationId: key }), /No formatting receipt/);
    await assert.rejects(restarted.format({ ...args(), account: 'other@example.test' }), /another request/);
  } finally { await h.close(); }
});
test('known successful revision can recover failed verification, but later drift is never recast as verification', async () => {
  const h = await setup({ readFailure: (_reads, writes) => writes > 0 });
  try {
    assert.equal((await h.service.format({ ...args(), preview: false })).outcome, 'uncertain');
    h.ports.docs.inspect = async () => structuredClone(h.doc);
    const fresh = createDocsFormatService(h.ports);
    assert.equal((await fresh.status({ account, operationId: key })).outcome, 'verified');
    h.doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold = false;
    assert.equal((await fresh.status({ account, operationId: key })).outcome, 'changed_since_verification'); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('durable write reservation failure and concurrent review cannot submit a provider write', async () => {
  const h = await setup();
  try {
    h.store.startFormattingWrite = async () => { throw new Error('private-storage-content'); };
    const result = await h.service.format({ ...args(), preview: false });
    assert.equal(result.outcome, 'not_submitted'); assert.equal(h.writes, 0);
  } finally { await h.close(); }
  const q = await setup();
  try {
    let release, reached;
    const waiting = new Promise(r => { release = r; }), entered = new Promise(r => { reached = r; });
    const done = q.service.format({ ...args(), preview: false }, undefined, async () => { reached(); await waiting; return { outcome: 'submitted', value: { approved: false } }; });
    await entered;
    const status = await q.service.status({ account, operationId: key }); assert.equal(status.inProgress, true);
    await assert.rejects(q.service.format({ ...args(), operationId: key2, preview: false }), /Another formatting/);
    assert.equal(q.writes, 0); release(); await done;
  } finally { await q.close(); }
});
test('rejected, malformed success, unapplied lost request and unavailable recovery never replay', async () => {
  for (const options of [{ rejected: true }, { malformed: true }, { lost: true, noApply: true }]) {
    const h = await setup(options);
    try {
      const r = await h.service.format({ ...args(), preview: false }); assert.equal(r.outcome, options.rejected ? 'rejected' : 'uncertain');
      h.ports.docs.inspect = async () => { throw new Error('private-token'); };
      const status = await h.service.status({ account, operationId: key }); assert.equal(status.outcome, options.rejected ? 'rejected' : 'verification_unavailable');
      assert.equal(h.writes, 1);
    } finally { await h.close(); }
  }
});

test('page-only inspection and formatting preserve structured bodies across tabs', async () => {
  const h = await setup();
  try {
    const body = h.doc.tabs[0].documentTab.body.content;
    body[1] = { startIndex: 1, endIndex: 10, table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 3, endIndex: 8, paragraph: { elements: [{ textRun: { content: 'private table text' } }] } }] }] }] } };
    h.doc.tabs[0].childTabs[0].documentTab.inlineObjects = { object1: { inlineObjectProperties: { embeddedObject: { title: 'private object' } } } };
    const before = structuredClone(h.doc), a = { ...args(), ranges: [], page: { tabId: 'tab-a', backgroundColor: '#123456' } };
    await assert.rejects(h.service.inspect({ account, document: 'doc-a' }));
    const inspected = await h.service.inspect({ account, document: 'doc-a', mode: 'page' });
    assert.equal(inspected.complete, true); assert.equal(inspected.revisionId, 'rev-a'); assert.equal(inspected.tabs.length, 2);
    assert.doesNotMatch(JSON.stringify(inspected), /private table text|private object/);
    await assert.rejects(h.service.format(args()));
    assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'verified');
    const expected = structuredClone(before); expected.revisionId = 'rev-b'; expected.tabs[0].documentTab.documentStyle.background = h.doc.tabs[0].documentTab.documentStyle.background;
    assert.deepEqual(h.doc, expected); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('page-only rejects malformed, partial, suggested or unknown page state before submission', async () => {
  const changes = [
    d => { d.tabs[0].documentTab.body.content[1] = { startIndex: 1, endIndex: 10, table: {} }; },
    d => { d.tabs[0].documentTab.body.content[1].startIndex = 2; },
    d => { d.tabs[0].childTabs[0].tabProperties.tabId = 'tab-a'; },
    d => { d.tabs[0].documentTab.documentStyle.futureStyle = {}; },
    d => { d.tabs[0].documentTab.documentStyle.suggestedDocumentStyleChanges = { private: {} }; },
    d => { d.tabs[0].documentTab.documentStyle.documentFormat = { documentMode: 'PAGES', unknown: true }; },
    d => { d.tabs[0].documentTab.documentStyle.pageSize = { width: {} }; },
  ];
  for (const change of changes) {
    const h = await setup();
    try { change(h.doc); await assert.rejects(h.service.format({ ...args(), ranges: [], page: { tabId: 'tab-a', marginTopPt: 60 } })); assert.equal(h.writes, 0); }
    finally { await h.close(); }
  }
});
test('page-only structured readback detects unrelated drift and lost responses stay observations', async () => {
  for (const options of [{ afterWrite: d => { d.tabs[0].documentTab.body.content[1].table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content = 'changed'; } }, { lost: true }]) {
    const h = await setup(options);
    try {
      h.doc.tabs[0].documentTab.body.content[1] = { startIndex: 1, endIndex: 10, table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'private table text' } }] } }] }] }] } };
      const a = { ...args(), ranges: [], page: { tabId: 'tab-a', marginTopPt: 60 } };
      assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'uncertain');
      const status = await h.service.status({ account, operationId: key });
      assert.equal(status.outcome, options.lost ? 'observed_matching' : 'uncertain');
      assert.doesNotMatch(JSON.stringify(status), /private table text/); assert.equal(h.writes, 1);
    } finally { await h.close(); }
  }
});

test('page-only revision and approval revalidation prevent writes on structured documents', async () => {
  for (const options of [{ stale: true }, { approval: (_p, d) => { d.tabs[0].documentTab.body.content[1].table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content = 'changed'; } }]) {
    const h = await setup(options);
    try {
      h.doc.tabs[0].documentTab.body.content[1] = { startIndex: 1, endIndex: 10, table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'private data' } }] } }] }] }] } };
      const a = { ...args(), ranges: [], page: { tabId: 'tab-a', marginTopPt: 60 }, expectedRevisionId: options.stale ? 'old' : 'rev-a' };
      if (options.stale) await assert.rejects(h.service.format(a), /revision/);
      else assert.equal((await h.service.format({ ...a, preview: false })).outcome, 'not_submitted');
      assert.equal(h.writes, 0); assert.doesNotMatch(JSON.stringify(h.logs), /private data/);
    } finally { await h.close(); }
  }
});
