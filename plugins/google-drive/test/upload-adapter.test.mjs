import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadAdapter } from '../adapters/upload.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { conversionTypes, XLSX } from '../core/upload.mjs';
const record = { subject: 'subject', email: 'owner@example.invalid' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
for (const mode of ['binary', 'xlsx_to_sheet', 'docx_to_doc', 'pptx_to_slides']) test(`${mode} multipart preserves every byte and sets explicit metadata MIME without retries`, async () => {
  const calls = [], bytes = Buffer.from([0, 255, 128, 13, 10, 80, 75]); let identities = 0;
  const adapter = createUploadAdapter({ verifiedAccess: async () => { identities++; return 'PRIVATE_TOKEN'; }, fetchImpl: async (url, init) => {
    calls.push([String(url), init]); return String(url).includes('tokeninfo') ? json({ scope: 'https://www.googleapis.com/auth/drive.file' }) : json({ id: 'new' });
  } });
  const write = await adapter.prepare(record); await write({ bytes, name: 'model.xlsx', mimeType: mode === 'binary' ? XLSX : conversionTypes[mode].source, resultMime: mode === 'binary' ? XLSX : conversionTypes[mode].result, destinationId: 'folder', operationId: 'uuid' });
  const mutations = calls.filter(c => c[0].includes('/upload/')); assert.equal(mutations.length, 1); assert.equal(identities, 2);
  const [url, req] = mutations[0]; assert.match(url, /uploadType=multipart/); assert.match(req.headers['content-type'], /^multipart\/related; boundary=/);
  const boundary = req.headers['content-type'].split('boundary=')[1], prefixEnd = req.body.indexOf(Buffer.from('\r\n\r\n'), req.body.indexOf(Buffer.from(`\r\n--${boundary}\r\n`))) + 4;
  assert.deepEqual(req.body.subarray(prefixEnd, prefixEnd + bytes.length), bytes);
  const meta = JSON.parse(req.body.subarray(req.body.indexOf('\r\n\r\n') + 4, req.body.indexOf(`\r\n--${boundary}\r\n`)).toString());
  assert.equal(meta.mimeType, mode === 'binary' ? XLSX : conversionTypes[mode].result); assert.ok(req.body.includes(Buffer.from(`Content-Type: ${mode === 'binary' ? XLSX : conversionTypes[mode].source}\r\n`))); assert.deepEqual(meta.parents, ['folder']); assert.deepEqual(meta.appProperties, { paLocalUpload: 'uuid' });
});
for (const response of ['transport', 401, 403, 429, 500, 'invalid']) test(`upload ${response} never retries`, async () => {
  let writes = 0;
  const adapter = createUploadAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async url => {
    if (String(url).includes('tokeninfo')) return json({ scope: 'https://www.googleapis.com/auth/drive' });
    writes++; if (response === 'transport') throw new Error('PRIVATE_BODY'); if (response === 'invalid') return new Response('PRIVATE_INVALID_JSON'); return json({ secret: 'PRIVATE_BODY' }, response);
  } });
  const writer = await adapter.prepare(record);
  await assert.rejects(writer({ bytes: Buffer.from('fixture'), name: 'test', mimeType: 'application/test', resultMime: 'application/test', destinationId: 'folder', operationId: 'uuid' })); assert.equal(writes, 1);
});
test('missing write grant prevents upload; read-only lookup is bounded and duplicate names are refused', async () => {
  let writes = 0, page = { files: [] };
  const adapter = createUploadAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async (url, init) => {
    if (String(url).includes('tokeninfo')) return json({ scope: 'https://www.googleapis.com/auth/drive.readonly' });
    if (init.method === 'POST') writes++; return json(page);
  } });
  await assert.rejects(adapter.prepare(record), e => e.uploadCode === 'scope'); assert.equal(writes, 0);
  for (const p of [{ files: [{ id: 'x' }] }, { files: [], nextPageToken: 'more' }, { files: [], incompleteSearch: true }]) { page = p; await assert.rejects(adapter.duplicates(record, 'folder', "Bob's file")); }
  page = { files: [{ id: 'one' }] }; assert.equal(await adapter.find(record, 'uuid'), 'one');
  page = { files: [{ id: 'one' }, { id: 'two' }] }; assert.equal(await adapter.find(record, 'uuid'), null);
});
test('upload reuses verified Google account identity and refuses a changed subject before grant inspection/media', async () => {
  let requests = 0;
  const adapter = createGoogleAdapter({ store: { bySubject: async () => ({ ...record, accessToken: 'PRIVATE_ACCESS', expiresAt: Date.now() + 600000 }) }, getClient: async () => ({}), fetchImpl: async url => {
    requests++; assert.match(String(url), /userinfo$/); return json({ sub: 'wrong', email: 'PRIVATE_ACCOUNT', email_verified: true });
  } });
  await assert.rejects(adapter.upload.prepare(record), e => e.code === 'reauthentication_required'); assert.equal(requests, 1);
});
test('native conversion readback reports bounded formula/error evidence, not full fidelity or raw formula/error messages', async () => {
  let grids = 0;
  const adapter = createUploadAdapter({ verifiedAccess: async () => 'x', sheets: {
    async metadata() { return { spreadsheetId: 'new', sheets: Array.from({ length: 11 }, (_, i) => ({ properties: { sheetId: i, title: `Tab${i}`, sheetType: 'GRID', gridProperties: { rowCount: 10000, columnCount: 100 } } })) }; },
    async readGrid(_r, _id, _tab, range) { grids++; assert.equal(range.rowCount, 10); assert.equal(range.columnCount, 10); return [{ rowData: [{ values: [{ userEnteredValue: { formulaValue: '=PRIVATE_FORMULA' }, effectiveValue: { errorValue: { type: 'DIVIDE_BY_ZERO', message: 'PRIVATE_PROVIDER' } } }] }] }]; },
  } });
  const r = await adapter.inspectSheet(record, 'new', { tabs: Array.from({ length: 11 }, (_, i) => `Tab${i}`), sourceFormulaCount: 50 });
  assert.equal(grids, 10); assert.equal(r.structureMatches, true); assert.equal(r.observedFormulaCount, 10); assert.equal(r.observedCalculationErrorCount, 10); assert.equal(r.fidelityVerified, false); assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});
