import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, link, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { crc32 } from 'node:zlib';
import { createUploadSource } from '../adapters/upload-source.mjs';
import { inspectXlsx } from '../adapters/xlsx-import.mjs';
const digest = b => createHash('sha256').update(b).digest('hex');
export function workbook({ formula = 'SUM(A1:A2)', extra = {}, workbookExtra = '', formulaAttrs = '', relations = '', typesExtra = '' } = {}) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({ '[Content_Types].xml': `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${typesExtra}</Types>`,
    'xl/workbook.xml': `<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets>${workbookExtra}</workbook>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row><c r="A1"><v>2</v></c><c r="B1"><f ${formulaAttrs}>${formula}</f><v>4</v></c></row></sheetData></worksheet>`,
    ...(relations ? { 'xl/_rels/workbook.xml.rels': relations } : {}), ...extra }).map(([k, v]) => [k, strToU8(v)]))));
}
test('source captures exact opaque bytes without parsing formulas, and never changes original', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upload-source-')), bytes = Buffer.from([0, 255, 128, 13, 10, 80, 75]);
  try {
    await mkdir(join(root, 'v1')); await writeFile(join(root, 'v1', 'model.xlsx'), bytes);
    const source = createUploadSource({ location: async () => root }), ref = { host: 'bb-server', threadId: 'thr_test', path: 'v1/model.xlsx' };
    const r = await source.capture(ref, digest(bytes), 'binary'); assert.deepEqual(r.bytes, bytes); assert.equal(r.sha256, digest(bytes));
    assert.deepEqual(await readFile(join(root, ref.path)), bytes);
    await utimes(join(root, ref.path), new Date(), new Date(Date.now() + 10000));
    assert.notEqual((await source.capture(ref, digest(bytes), 'binary')).version, r.version);
    await assert.rejects(source.capture(ref, '0'.repeat(64), 'binary'), e => e.uploadCode === 'changed');
    await assert.rejects(source.capture(ref, digest(bytes), 'xlsx_to_sheet'), e => e.uploadCode === 'conversion');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('path/host/filesystem boundary rejects traversal, hidden secrets, symlinks, hardlinks, devices, FIFO, oversize, directories and foreign platforms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upload-boundary-')); try {
    await writeFile(join(root, 'safe'), 'fixture'); await symlink('safe', join(root, 'alias')); await symlink('/dev', join(root, 'device'));
    await mkdir(join(root, 'dir')); await symlink('dir', join(root, 'aliasdir')); await writeFile(join(root, 'large'), Buffer.alloc(4194305));
    execFileSync('mkfifo', [join(root, 'fifo')]);
    const source = createUploadSource({ location: async () => root }), ref = path => ({ host: 'bb-server', threadId: 'thr_test', path });
    for (const path of ['../safe', '/safe', 'dir/../safe', '.env', 'dir/.secret', 'credentials.json', 'id_rsa', 'key.pem', 'alias', 'aliasdir/file', 'device/null', 'fifo', 'large', 'dir', 'file://safe', 'dir\\safe']) await assert.rejects(source.capture(ref(path), digest('fixture'), 'binary'), undefined, path);
    await link(join(root, 'safe'), join(root, 'hard')); await assert.rejects(source.capture(ref('hard'), digest('fixture'), 'binary'), e => e.uploadCode === 'source');
    await assert.rejects(createUploadSource({ location: async () => root, platform: 'win32' }).capture(ref('safe'), digest('fixture'), 'binary'));
    await assert.rejects(source.capture({ ...ref('safe'), host: 'client' }, digest('fixture'), 'binary'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('XLSX gate inspects inert formulas and tab structure without altering ZIP bytes', () => {
  const bytes = workbook(), copy = Buffer.from(bytes), r = inspectXlsx(bytes, 'model.xlsx'); assert.deepEqual(r.tabs, ['Budget']); assert.equal(r.sourceFormulaCount, 1); assert.deepEqual(bytes, copy);
  for (const options of [
    { formula: 'WEBSERVICE(&quot;https://example.invalid&quot;)' }, { formula: '_xlfn.IMPORTDATA(A1)' }, { formula: '[external.xlsx]Sheet!A1' }, { formula: 'UnknownFunction(A1)' },
    { formulaAttrs: 't="shared"' }, { extra: { 'xl/vbaProject.bin': 'inert' } }, { extra: { 'xl/connections.xml': '<connections/>' } },
    { relations: '<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>' },
    { relations: '<Relationships><Relationship TargetMode="External" Target="h&#x74;tps://example.invalid"/></Relationships>' },
    { workbookExtra: '<definedNames><definedName name="hidden">WEBSERVICE(A1)</definedName></definedNames>' },
    { extra: { 'xl/worksheets/evil.xml': '<!DOCTYPE a [<!ENTITY x "payload">]><x/>' } },
    { extra: { 'xl/huge.xml': 'x'.repeat(4194305) } },
  ]) assert.throws(() => inspectXlsx(workbook(options), 'model.xlsx'), e => e.uploadCode === 'conversion', JSON.stringify(options).slice(0, 200));
  assert.throws(() => inspectXlsx(bytes, 'model.xlsm'));
});
test('review regressions: noncanonical worksheet parts, VBA Defaults/relationships and forged ZIP sizes fail closed', () => {
  const variants = [
    { extra: { 'xl/custom/sheet.xml': '<worksheet><c><f>WEBSERVICE(A1)</f></c></worksheet>' }, relations: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="custom/sheet.xml"/></Relationships>' },
    { extra: { 'xl/custom/sheet.xml': '<worksheet><c><f>WEBSERVICE(A1)</f></c></worksheet>' } },
    { extra: { 'xl/custom/validation.xml': '<validation><formula1>WEBSERVICE(A1)</formula1></validation>' } },
    { extra: { 'xl/payload.bin': '<workbook><definedName name="bad">WEBSERVICE(A1)</definedName></workbook>' }, relations: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/payload.bin"/></Relationships>' },
    { typesExtra: '<Override PartName="/xl/payload.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>', extra: { 'xl/payload.bin': '<workbook/>' } },
    { workbookExtra: '<definedNames><definedName name="_xlnm.Print_Area">WEBSERVICE(A1)</definedName></definedNames>' },
    { extra: { 'xl/payload.bin': 'inert' }, typesExtra: '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' },
    { extra: { 'xl/payload.bin': 'inert' }, relations: '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="payload.bin"/></Relationships>' },
  ];
  for (const v of variants) assert.throws(() => inspectXlsx(workbook(v), 'model.xlsx'), e => e.uploadCode === 'conversion');
  const forged = workbook({ extra: { 'xl/worksheets/sheet2.xml': `<worksheet>${' '.repeat(5 * 1024 * 1024)}</worksheet>` } });
  // Forge BOTH central/local declared uncompressed sizes; only bounded ACTUAL
  // inflation can reject this consistently before inspecting truncated XML.
  let cursor = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (cursor >= 0 && forged.readUInt32LE(cursor) === 0x02014b50) {
    const len = forged.readUInt16LE(cursor + 28), name = forged.subarray(cursor + 46, cursor + 46 + len).toString();
    if (name === 'xl/worksheets/sheet2.xml') { forged.writeUInt32LE(35, cursor + 24); forged.writeUInt32LE(35, forged.readUInt32LE(cursor + 42) + 22); break; }
    cursor += 46 + len + forged.readUInt16LE(cursor + 30) + forged.readUInt16LE(cursor + 32);
  }
  assert.throws(() => inspectXlsx(forged, 'model.xlsx'), e => e.uploadCode === 'conversion');
  const inconsistent = workbook(); const central = inconsistent.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); inconsistent.writeUInt32LE(1, central + 24);
  assert.throws(() => inspectXlsx(inconsistent, 'model.xlsx'), e => e.uploadCode === 'conversion');
});
test('second review regressions: filename aliases/unknown extras and EOCD fallthrough are refused', () => {
  const alias = Buffer.alloc(5); alias[0] = 1; alias.writeUInt32LE(crc32(Buffer.from('xl/payload.bin')), 1);
  const bytes = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': strToU8('<workbook><sheet name="Budget"/></workbook>'),
    'xl/payload.bin': [strToU8('<worksheet><c><f>WEBSERVICE(A1)</f></c></worksheet>'), { extra: { 0x7075: Buffer.concat([alias, Buffer.from('xl/worksheets/sheet1.xml')]) } }],
  }));
  assert.throws(() => inspectXlsx(bytes, 'model.xlsx'), e => e.uploadCode === 'conversion');
  for (const padding of [1, 65535, 65536, 65537]) assert.throws(() => inspectXlsx(Buffer.concat([workbook(), Buffer.alloc(padding)]), 'model.xlsx'), e => e.uploadCode === 'conversion');
});
