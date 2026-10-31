import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createDocsImageService, imageRequest, inspectImages, imageReadback, imageSchema } from '../core/docs-image.mjs';
import { createDocsFormatService } from '../core/docs-format.mjs';
import { createDocsEditService } from '../core/docs-edit.mjs';
import { document, tab, account, record } from './docs-fixtures.mjs';
export const key = '11111111-1111-4111-8111-111111111111', key2 = '22222222-2222-4222-8222-222222222222';
export const imageArgs = () => ({ account, document: 'doc-a', operationId: key, expectedRevisionId: 'rev-a', tabId: 'tab-a', index: 1, uri: 'https://example.test/logo.png', widthPt: 172.8 });
export const asset = { mimeType: 'image/png', width: 1600, height: 240, bytes: 4096, sha256: 'a'.repeat(64) };
// Independent synthetic provider: implements the API's one-unit additive image.
export function applyImage(doc, args, id = 'new-logo') {
  const all = []; function visit(nodes) { for (const t of nodes) { all.push(t); visit(t.childTabs || []); } } visit(doc.tabs);
  const data = all.find(t => t.tabProperties.tabId === args.tabId).documentTab;
  const p = data.body.content.find(p => p.startIndex === args.index && p.paragraph); assert.ok(p);
  for (const item of data.body.content) {
    if (item.startIndex > args.index) item.startIndex++;
    if (item.endIndex > args.index) item.endIndex++;
    for (const e of item.paragraph?.elements || []) { if (e.startIndex >= args.index) e.startIndex++; if (e.endIndex > args.index) e.endIndex++; }
  }
  p.paragraph.elements.unshift({ startIndex: args.index, endIndex: args.index + 1, inlineObjectElement: { inlineObjectId: id, textStyle: {} } });
  data.inlineObjects ||= {};
  data.inlineObjects[id] = { objectId: id, inlineObjectProperties: { embeddedObject: { size: { width: { magnitude: args.widthPt, unit: 'PT' }, height: { magnitude: args.widthPt * asset.height / asset.width, unit: 'PT' } }, imageProperties: { sourceUri: args.uri, contentUri: 'https://google.test/transient' } } } };
  doc.revisionId = 'rev-b'; return doc;
}
export async function setupImage(options = {}) {
  const h = createFakePluginHost({ pluginId: 'image-tests' }), store = createBbStore(h.bb.storage.database(), h.bb.storage.migrate);
  await store.addAccount({ ...record, refreshToken: 'synthetic-refresh' });
  let doc = document('Wordmark 😀\n'), writes = 0, approvals = 0, reads = 0, assetReads = 0;
  doc.tabs[0].childTabs = [tab('Other tab\n', 'tab-b')];
  const logs = [];
  const ports = { store, drive: { getFile: async () => { if (writes && options.metadataFailure) throw Object.assign(new Error('PRIVATE_READBACK'), { docsCode: options.metadataFailure }); return { id: 'doc-a', trashed: false, mimeType: 'application/vnd.google-apps.document' }; } },
    docs: { inspect: async () => { reads++; if (options.readFail?.(reads, writes)) throw Object.assign(new Error('PRIVATE_READ_TOKEN'), { docsCode: options.readCode }); return structuredClone(doc); },
      prepareWrite: async () => { if (options.noGrant) throw Object.assign(new Error('PRIVATE_GRANT'), { docsCode: 'scope_required' }); return { insertImage: async (args, _signal, beforeSubmission) => {
        try { await beforeSubmission?.(); } catch (error) { throw Object.assign(error, { docsWriteAttempted: false }); }
        writes++; assert.deepEqual(imageRequest(args), { insertInlineImage: { uri: args.uri, location: { tabId: args.tabId, index: args.index }, objectSize: { width: { magnitude: args.widthPt, unit: 'PT' } } } });
        if (options.rejected) throw Object.assign(new Error('PRIVATE_REJECT'), { docsCode: 'write_rejected' });
        if (!options.noApply) applyImage(doc, args);
        options.afterWrite?.(doc);
        if (options.lost) throw new Error('PRIVATE_LOST_RESPONSE');
        return options.response?.() ?? { documentId: 'doc-a', replies: [{ insertInlineImage: { objectId: 'new-logo' } }], writeControl: { requiredRevisionId: 'rev-b' } };
      } }; } },
    assets: { inspect: async () => { assetReads++; return options.asset?.(assetReads) || structuredClone(asset); } },
    clock: options.clock, approvalRequired: options.approvalRequired, diagnose: (stage, error) => logs.push(stage) };
  const approve = async p => { approvals++; await options.approval?.(p, doc); return options.decision || { outcome: 'submitted', value: { approved: true } }; };
  const service = createDocsImageService(ports);
  return { h, store, ports, service, approve, logs, get doc() { return doc; }, get writes() { return writes; }, get approvals() { return approvals; }, get assetReads() { return assetReads; }, close: () => h.harness.lifecycle.dispose() };
}
test('complete inspection, preview, additive insertion, exact source/size/style/tab preservation and no replay', async () => {
  const h = await setupImage(); try {
    const before = structuredClone(h.doc);
    assert.equal((await h.service.inspect({ account, document: 'doc-a' })).tabs[0].paragraphs[0].index, 1);
    const p = await h.service.insert(imageArgs()); assert.equal(p.outcome, 'proposed'); assert.equal(h.writes, 0); assert.equal(h.approvals, 0);
    const out = await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve);
    assert.equal(out.outcome, 'verified'); assert.equal(out.objectId, 'new-logo'); assert.equal(h.writes, 1); assert.equal(h.approvals, 1);
    assert.equal(h.doc.tabs[0].documentTab.body.content[1].paragraph.elements[1].textRun.content, 'Wordmark 😀\n');
    assert.deepEqual(h.doc.tabs[0].childTabs, before.tabs[0].childTabs);
    const inspected = await h.service.inspect({ account, document: 'doc-a' });
    assert.equal(inspected.tabs[0].paragraphs[0].text, '\uFFFCWordmark 😀\n');
    assert.deepEqual(inspected.tabs[0].paragraphs[0].inlineObjects, [{ index: 1, objectId: 'new-logo' }]);
    assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve)).outcome, 'verified'); assert.equal(h.writes, 1);
    assert.equal((await h.service.status({ account, operationId: key })).outcome, 'verified');
  } finally { await h.close(); }
});
test('nested tab explicit placement and later paragraph UTF-16 shifts preserve emoji and styles', async () => {
  const h = await setupImage(); try {
    const data = h.doc.tabs[0].childTabs[0].documentTab, start = data.body.content.at(-1).endIndex;
    data.body.content.push({ startIndex: start, endIndex: start + 4, paragraph: { elements: [{ startIndex: start, endIndex: start + 4, textRun: { content: '😀x\n', textStyle: { bold: true } } }] } });
    const a = { ...imageArgs(), tabId: 'tab-b', index: start };
    const result = await h.service.insert({ ...a, preview: false }, undefined, h.approve); assert.equal(result.outcome, 'verified');
    assert.equal(h.doc.tabs[0].documentTab.inlineObjects, undefined);
    assert.equal(data.body.content.at(-1).paragraph.elements[1].endIndex, start + 5);
  } finally { await h.close(); }
});
test('insertion does not grant text/paragraph editing; page-only formatting inspection stays usable', async () => {
  const h = await setupImage(); try {
    await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve);
    const edit = createDocsEditService(h.ports), format = createDocsFormatService(h.ports);
    await assert.rejects(() => edit.inspect({ account, document: 'doc-a' }), /ordinary text paragraphs/);
    await assert.rejects(() => format.inspect({ account, document: 'doc-a' }), /ordinary text paragraphs/);
    assert.equal((await format.inspect({ account, document: 'doc-a', mode: 'page' })).complete, true);
  } finally { await h.close(); }
});
for (const decision of [{ outcome: 'submitted', value: { approved: false } }, { outcome: 'cancelled', reason: 'timeout' }, { outcome: 'cancelled', reason: 'request-aborted' }, { outcome: 'submitted', value: { approved: 'yes' } }]) test(`approval fails closed ${JSON.stringify(decision)}`, async () => {
  const h = await setupImage({ decision }); try { const r = await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve); assert.notEqual(r.outcome, 'verified'); assert.equal(r.writeAttempted, false); assert.equal(h.writes, 0); } finally { await h.close(); }
});
test('scope failure and abort never submit; missing policy fails closed', async () => {
  for (const options of [{ noGrant: true }, { approvalRequired: async () => { throw new Error('PRIVATE_POLICY'); } }]) {
    const h = await setupImage(options); try { assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve)).writeAttempted, false); assert.equal(h.writes, 0); } finally { await h.close(); }
  }
  const h = await setupImage(); try { const controller = new AbortController(); controller.abort(); assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, controller.signal, h.approve)).writeAttempted, false); assert.equal(h.writes, 0); } finally { await h.close(); }
});
test('owner settings standing consent and policy re-enable are honored without argument bypass', async () => {
  const h = await setupImage({ approvalRequired: async () => false }); try { assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve)).approval, 'disabled_in_settings'); assert.equal(h.approvals, 0); } finally { await h.close(); }
  let calls = 0;
  const h2 = await setupImage({ approvalRequired: async () => ++calls > 1 }); try { assert.equal((await h2.service.insert({ ...imageArgs(), preview: false }, undefined, h2.approve)).outcome, 'approval_required'); assert.equal(h2.writes, 0); } finally { await h2.close(); }
  for (const extra of [{ requireApproval: false }, { altText: 'Logo' }, { replaceText: 'wordmark' }, { rawRequests: [] }]) assert.equal(imageSchema.safeParse({ ...imageArgs(), ...extra }).success, false);
});
test('changed revision, unchanged-revision content/style tamper, changed asset and expiry block submission', async () => {
  for (const options of [
    { approval: async (_p, doc) => { doc.revisionId = 'rev-new'; } },
    { approval: async (_p, doc) => { doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle = { bold: false }; } },
    { asset: n => ({ ...asset, sha256: (n > 1 ? 'b' : 'a').repeat(64) }) },
  ]) { const h = await setupImage(options); try { const r = await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve); assert.equal(r.outcome, 'not_submitted'); assert.equal(h.writes, 0); } finally { await h.close(); } }
  let now = 0; const h = await setupImage({ clock: () => now }); try { await h.service.insert(imageArgs()); now = 600000; assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve)).outcome, 'expired'); assert.equal(h.approvals, 0); } finally { await h.close(); }
});
for (const options of [{ lost: true }, { response: () => ({}) }, { response: () => ({ documentId: 'OTHER', replies: [{}] }) }, { response: () => ({ documentId: 'doc-a', replies: [{ insertInlineImage: { objectId: 'wrong-id' } }], writeControl: { requiredRevisionId: 'rev-b' } }) }]) test(`lost/malformed/mismatched responses retain uncertain durable claim ${JSON.stringify(options)}`, async () => {
  const h = await setupImage(options); try {
    const r = await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve); assert.equal(r.outcome, 'uncertain');
    const restarted = createDocsImageService(h.ports), status = await restarted.status({ account, operationId: key });
    assert.ok(['observed_matching','uncertain'].includes(status.outcome));
    assert.equal(await h.store.images.active('doc-a'), key);
    await restarted.insert({ ...imageArgs(), preview: false }, undefined, h.approve); assert.equal(h.writes, 1);
    await assert.rejects(() => restarted.insert({ ...imageArgs(), operationId: key2, expectedRevisionId: 'rev-b', preview: false }, undefined, h.approve), /recover|Recover/);
  } finally { await h.close(); }
});
test('acknowledged insertion with temporary read failure can recover verified without a second write', async () => {
  const h = await setupImage({ readFail: (n, writes) => n === 3 && writes > 0 }); try {
    assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve)).outcome, 'uncertain');
    assert.equal((await createDocsImageService(h.ports).status({ account, operationId: key })).outcome, 'verified'); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('verification detects source/size/style/other-tab/original-object changes', async () => {
  for (const change of [
    d => { d.tabs[0].documentTab.inlineObjects['new-logo'].inlineObjectProperties.embeddedObject.imageProperties.sourceUri = 'https://other.test/logo.png'; },
    d => { d.tabs[0].documentTab.inlineObjects['new-logo'].inlineObjectProperties.embeddedObject.size.width.magnitude++; },
    d => { d.tabs[0].documentTab.body.content[1].paragraph.elements[1].textRun.textStyle = { bold: false }; },
    d => { d.tabs[0].childTabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content = 'Different\n'; },
  ]) { const h = await setupImage({ afterWrite: change }); try { assert.equal((await h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve)).outcome, 'uncertain'); } finally { await h.close(); } }
});
test('document/account/key binding, bounds and unsupported structures', async () => {
  const h = await setupImage(); try {
    await h.service.insert(imageArgs());
    await assert.rejects(() => h.service.insert({ ...imageArgs(), widthPt: 100 }), /another/);
    await assert.rejects(() => h.service.status({ account: 'unknown@example.test', operationId: key }), /Unknown/);
    for (const patch of [{ index: 2 }, { tabId: 'absent' }, { expectedRevisionId: 'stale' }]) await assert.rejects(() => h.service.insert({ ...imageArgs(), operationId: key2, ...patch }));
    for (const patch of [{ widthPt: 0 }, { widthPt: Infinity }, { index: 1.5 }, { operationId: 'AAAAAAAA-1111-4111-8111-111111111111' }]) assert.equal(imageSchema.safeParse({ ...imageArgs(), ...patch }).success, false);
    for (const mutate of [d => { d.tabs[0].documentTab.namedRanges = { r: {} }; }, d => { d.tabs[0].documentTab.body.content[1].paragraph.bullet = { listId: 'x' }; }, d => { d.tabs[0].documentTab.headers = { h: {} }; }, d => { d.tabs[0].documentTab.inlineObjects = { orphan: {} }; }, d => { d.tabs[0].documentTab.body.content[1].paragraph.elements[0].suggestedInsertionIds = ['x']; }]) { const d = document('x\n'); mutate(d); assert.throws(() => inspectImages(d, 'doc-a')); }
  } finally { await h.close(); }
});
test('active image claim serializes images and formatting, blocks legacy replacement and survives service restart', async () => {
  let release; const gate = new Promise(r => { release = r; }); let entered; const enteredGate = new Promise(r => { entered = r; });
  const h = await setupImage({ approval: async () => { entered(); await gate; } }); try {
    const work = h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve); await enteredGate;
    assert.equal((await createDocsImageService(h.ports).status({ account, operationId: key })).inProgress, undefined);
    await assert.rejects(() => createDocsImageService(h.ports).insert({ ...imageArgs(), operationId: key2, preview: false }, undefined, h.approve), /Another|operation/);
    assert.equal(await h.store.claimFormatting(key2, 'doc-a'), false);
    const edit = createDocsEditService(h.ports);
    await assert.rejects(() => edit.replace({ account, document: 'doc-a', expectedRevisionId: 'rev-a', tabId: 'tab-a', oldText: 'Wordmark', newText: 'Other', preview: false }), /image operation/);
    release(); assert.equal((await work).outcome, 'verified');
  } finally { release?.(); await h.close(); }
});
test('formatting claims block image claims and operation keys are shared across image/format tables', async () => {
  const h = await setupImage(); try {
    await h.store.reserveFormatting({ operationId: key2, subject: record.subject, documentId: 'doc-a', state: 'proposed' });
    assert.equal(await h.store.claimFormatting(key2, 'doc-a'), true);
    await assert.rejects(() => h.service.insert({ ...imageArgs(), preview: false }, undefined, h.approve), /operation/);
    await assert.rejects(() => h.service.insert({ ...imageArgs(), operationId: key2 }), /another/);
  } finally { await h.close(); }
});
