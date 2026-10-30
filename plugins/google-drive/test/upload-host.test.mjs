import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { registerUploadTools } from '../upload-tools.ts';
import { conversionTypes } from '../core/upload.mjs';
import { officeFixture } from './office-fixtures.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
async function setup({ foreignHost = false, privateFailure = false, mode = 'binary', rejectOffice = false, readbackFailure = false } = {}) {
  const name = mode === 'docx_to_doc' ? 'sample.docx' : mode === 'pptx_to_slides' ? 'sample.pptx' : 'sample.bin';
  const root = await mkdtemp(join(tmpdir(), 'upload-host-')); const bytes = mode === 'binary' ? Buffer.from('synthetic source bytes') : officeFixture(mode, rejectOffice ? { body: '<untrusted xmlns="urn:PRIVATE_XML_TOKEN"/>' } : {}); await writeFile(join(root, name), bytes);
  const h = createFakePluginHost({ pluginId: 'google-drive', sdk: { system: { config: async () => ({ primaryHostId: 'server' }) }, threads: { storageLocation: async ({ threadId }) => { assert.equal(threadId, 'thr_source'); return { hostId: foreignHost ? 'foreign' : 'server', storageRootPath: root }; } } } });
  const store = createBbStore(h.bb.storage.database(), (db, statements) => h.bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'subject', email: 'owner@example.invalid', refreshToken: 'PRIVATE_TOKEN' });
  let writes = 0, file;
  const adapter = { filing: { async assessDestination() { if (privateFailure) throw Object.assign(new Error('PRIVATE_ACCOUNT_CONTENT'), { status: 503, cause: 'PRIVATE_CAUSE', code: 'PRIVATE_CODE' }); return { destinationId: 'dest', fingerprint: 'access', contextIds: ['dest', 'root'], allowedAccess: [], path: 'My Drive / Team', owners: 'Foreign owner', audience: 'team@example.invalid — Can edit' }; }, async verifyCreated() { return true; } },
    upload: { async duplicates() {}, async prepare() { return async r => { await r.beforeSubmission?.(); writes++; assert.deepEqual(r.bytes, bytes); file = { id: 'new', name: r.name, mimeType: r.resultMime, size: bytes.length, md5Checksum: createHash('md5').update(bytes).digest('hex'), sha256Checksum: sha(bytes), parents: ['dest'], appProperties: { paLocalUpload: r.operationId }, trashed: false }; return { id: 'new' }; }; }, async get() { return file; }, async find() { return 'new'; }, async inspectDoc(_r, _id, evidence) { if (readbackFailure) throw new Error('PRIVATE_NATIVE_CONTENT_TOKEN'); assert.equal(evidence.kind, 'doc'); return { structureMatches: true, fidelityVerified: false }; }, async inspectSlides(_r, _id, evidence) { if (readbackFailure) throw new Error('PRIVATE_NATIVE_CONTENT_TOKEN'); assert.equal(evidence.slides.length, 2); return { structureMatches: true, fidelityVerified: false }; } } };
  registerUploadTools(h.bb, store, adapter);
  return { ...h, root, writes: () => writes, input: { account: 'owner@example.invalid', operationId: randomUUID(), source: { host: 'bb-server', threadId: 'thr_source', path: name }, expectedSha256: sha(bytes), folderId: 'dest', name, mimeType: mode === 'binary' ? 'application/octet-stream' : conversionTypes[mode].source, mode }, close: async () => { await h.harness.lifecycle.dispose(); await rm(root, { recursive: true, force: true }); } };
}
async function pending(h) { for (let i = 0; i < 200; i++) { if (h.inspection.pendingInteractions.length) return h.inspection.pendingInteractions[0]; await new Promise(r => setTimeout(r, 2)); } throw new Error('No synthetic upload review'); }
const parse = r => { assert.notEqual(r.isError, true, r.content[0].text); return JSON.parse(r.content[0].text); };
test('native upload binds exact owner review to local source and server path, no write until approved', async () => {
  const h = await setup(); try {
    assert.equal(parse(await h.harness.behavior.callAgentTool('gdrive_upload_file', h.input)).outcome, 'proposed'); assert.equal(h.writes(), 0);
    const done = h.harness.behavior.callAgentTool('gdrive_upload_file', { ...h.input, preview: false }), form = await pending(h.harness);
    assert.equal(form.rendererId, 'drive-upload-approval'); assert.equal(form.payload.sourcePath, join(h.root, 'sample.bin')); assert.equal(form.payload.sha256, h.input.expectedSha256); assert.equal(form.payload.mode, 'binary'); assert.equal(h.writes(), 0);
    h.harness.behavior.submitInteraction(form.id, { approved: true }); assert.equal(parse(await done).outcome, 'verified'); assert.equal(h.writes(), 1);
    assert.equal(parse(await h.harness.behavior.callAgentTool('gdrive_upload_status', { account: h.input.account, operationId: h.input.operationId })).outcome, 'verified'); assert.equal(h.writes(), 1);
  } finally { await h.close(); }
});
for (const mode of ['docx_to_doc', 'pptx_to_slides']) test(`${mode}: native tool inspects synthetic OOXML then binds mandatory exact source/mode/result approval`, async () => {
  const h = await setup({ mode }); try {
    const capabilities = await h.harness.behavior.callRpc('uploadCapabilities', null); assert.ok(capabilities.modes.includes(mode));
    const p = parse(await h.harness.behavior.callAgentTool('gdrive_upload_file', h.input)); assert.equal(p.outcome, 'proposed'); assert.equal(h.writes(), 0);
    const done = h.harness.behavior.callAgentTool('gdrive_upload_file', { ...h.input, preview: false }), form = await pending(h.harness);
    assert.equal(form.payload.mode, mode); assert.equal(form.payload.resultMime, conversionTypes[mode].result); assert.equal(form.payload.sha256, h.input.expectedSha256);
    h.harness.behavior.submitInteraction(form.id, { approved: true });
    const r = parse(await done); assert.equal(r.outcome, 'verified'); assert.equal(r.evidence.fidelityVerified, false); assert.equal(h.writes(), 1);
    assert.equal(parse(await h.harness.behavior.callAgentTool('gdrive_upload_status', { account: h.input.account, operationId: h.input.operationId })).outcome, 'verified'); assert.equal(h.writes(), 1);
  } finally { await h.close(); }
});
for (const mode of ['docx_to_doc', 'pptx_to_slides']) test(`${mode}: conversion refusal and native readback failure produce safe diagnostics without retry`, async () => {
  const rejected = await setup({ mode, rejectOffice: true }); try {
    const r = await rejected.harness.behavior.callAgentTool('gdrive_upload_file', rejected.input);
    assert.equal(r.isError, true); assert.equal(rejected.writes(), 0);
    assert.match(JSON.stringify(rejected.harness.inspection.logEntries), /upload_agent_tool conversion/);
    assert.doesNotMatch(JSON.stringify(r) + JSON.stringify(rejected.harness.inspection.logEntries), /PRIVATE_|sample.docx|sample.pptx|owner@example/);
  } finally { await rejected.close(); }
  const h = await setup({ mode, readbackFailure: true }); try {
    const done = h.harness.behavior.callAgentTool('gdrive_upload_file', { ...h.input, preview: false }), form = await pending(h.harness);
    h.harness.behavior.submitInteraction(form.id, { approved: true }); assert.equal(parse(await done).outcome, 'uncertain');
    const r = parse(await h.harness.behavior.callAgentTool('gdrive_upload_status', { account: h.input.account, operationId: h.input.operationId }));
    assert.equal(r.outcome, 'verification_unavailable'); assert.equal(h.writes(), 1);
    assert.match(JSON.stringify(h.harness.inspection.logEntries), /upload_verify/);
    assert.doesNotMatch(JSON.stringify(r) + JSON.stringify(h.harness.inspection.logEntries), /PRIVATE_|owner@example/);
  } finally { await h.close(); }
});
test('native source edit after owner review fails without submitting captured or replacement bytes', async () => {
  const h = await setup(); try {
    const done = h.harness.behavior.callAgentTool('gdrive_upload_file', { ...h.input, preview: false }), form = await pending(h.harness);
    await writeFile(join(h.root, 'sample.bin'), 'changed'); h.harness.behavior.submitInteraction(form.id, { approved: true });
    assert.equal(parse(await done).outcome, 'not_created'); assert.equal(h.writes(), 0);
  } finally { await h.close(); }
});
for (const options of [{ foreignHost: true }, { privateFailure: true }]) test(`safe attributed refusal ${JSON.stringify(options)}`, async () => {
  const h = await setup(options); try {
    const r = await h.harness.behavior.callAgentTool('gdrive_upload_file', h.input); assert.equal(r.isError, true); assert.equal(h.writes(), 0);
    const logs = JSON.stringify(h.harness.inspection.logEntries); assert.match(logs, /upload_agent_tool/); assert.doesNotMatch(logs + JSON.stringify(r), /PRIVATE_|sample.bin|owner@example|team@example|upload-host-/);
  } finally { await h.close(); }
});
