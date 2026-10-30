import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectOffice } from '../adapters/office-import.mjs';
import { createUploadSource } from '../adapters/upload-source.mjs';
import { createUploadAdapter } from '../adapters/upload.mjs';
import { officeFixture, O, W, P, A, R } from './office-fixtures.mjs';
const names = { docx_to_doc: 'example.docx', pptx_to_slides: 'example.pptx' };
for (const mode of Object.keys(names)) {
  test(`${mode}: shared ZIP gate, bounded inert editable structure/text evidence, unchanged source`, async () => {
    const bytes = officeFixture(mode), copy = Buffer.from(bytes), evidence = inspectOffice(bytes, names[mode], mode);
    assert.equal(evidence.kind, mode === 'docx_to_doc' ? 'doc' : 'slides'); assert.deepEqual(bytes, copy);
    assert.doesNotMatch(JSON.stringify(evidence), /Hello editable|Slide 1 editable/);
    if (evidence.slides) assert.equal(evidence.slides.length, 2);
    const root = await mkdtemp(join(tmpdir(), 'office-fixture-'));
    try {
      await writeFile(join(root, names[mode]), bytes);
      const source = createUploadSource({ location: async () => root });
      const captured = await source.capture({ host: 'bb-server', threadId: 'thr_test', path: names[mode] }, createHash('sha256').update(bytes).digest('hex'), mode);
      assert.deepEqual(captured.conversion, evidence); assert.deepEqual(await readFile(join(root, names[mode])), copy);
      assert.equal((await source.capture({ host: 'bb-server', threadId: 'thr_test', path: names[mode] }, captured.sha256, 'binary')).conversion, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test(`${mode}: macros/executables/embeddings, external/unknown rels, XML active content and unsupported formats fail closed`, () => {
    const word = mode === 'docx_to_doc', prefix = word ? 'word' : 'ppt';
    const relpath = word ? 'word/_rels/document.xml.rels' : 'ppt/slides/_rels/slide1.xml.rels';
    const variants = [
      { extra: { [`${prefix}/vbaProject.bin`]: 'INERT' } }, { extra: { [`${prefix}/embeddings/payload.bin`]: 'INERT' } },
      { extra: { [`${prefix}/payload.exe`]: 'INERT' } }, { extra: { [`${prefix}/media/payload.svg`]: '<svg/>' } },
      { extra: { [`${prefix}/customXml.xml`]: '<x/>' } },
      ...['External', 'external', 'Unexpected'].map(m => ({ extra: { [relpath]: `<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="x" Type="${R}/image" Target="https://example.invalid/a" TargetMode="${m}"/></Relationships>` } })),
      { extra: { [relpath]: `<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="x" Type="${R}/attachedTemplate" Target="${word ? 'document.xml' : 'slide1.xml'}"/></Relationships>` } },
      { extra: { [relpath]: `<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="x" Type="${R}/image" Target="%2e%2e/payload"/></Relationships>` } },
      { types: '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' },
      { body: word ? '<w:instrText>DDE AUTO</w:instrText>' : `<a:hlinkClick xmlns:a="${A}" action="ppaction://program"/>` },
      { body: word ? '<w:fldSimple w:instr="INCLUDETEXT remote"/>' : '<p:oleObj/>' },
      { body: word ? '<w:altChunk/>' : '<p:control/>' },
      { body: '<unknown xmlns="urn:untrusted"/>' },
      { body: `<w:p xmlns:w="${W}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${W} https://external.example.invalid/schema.xsd"/>` },
      { body: `<w:p xmlns:w="${W}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://external.example.invalid/schema.xsd"/>` },
      { body: word ? '<w:saveThroughXslt w:solutionID="external"/>' : '<p:timing><p:tnLst><p:cmd type="call" cmd="playFrom(0.0)"/></p:tnLst></p:timing>' },
      { body: `<a:audioCd xmlns:a="${A}"/>` },
      { body: `<w:p xmlns:w="${W}" xmlns:r="${R}" r:link="https://example.invalid"/>` },
      { body: `<w:p xmlns:w="${W}" xmlns:r="${R}" r:id="unresolved"/>` },
      { body: `<w:p xmlns:w="${W}" xml:base="https://example.invalid"/>` },
      { body: '<!DOCTYPE malicious>' }, { body: '<?remote instruction?>' },
      word ? { body: `<w:p><w:r><w:t>${'a'.repeat(40001)}</w:t></w:r></w:p>` } : { extra: { 'ppt/slides/slide1.xml': `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><a:p><a:r><a:t>${'a'.repeat(40001)}</a:t></a:r></a:p></p:cSld></p:sld>` } },
    ];
    for (const v of variants) assert.throws(() => inspectOffice(officeFixture(mode, v), names[mode], mode), e => e.uploadCode === 'conversion', JSON.stringify(v).slice(0,150));
    for (const ext of ['doc', 'ppt', 'docm', 'pptm', 'pdf', 'odt', 'html', 'rtf']) assert.throws(() => inspectOffice(officeFixture(mode), `file.${ext}`, mode));
    for (const padding of [1, 65536]) assert.throws(() => inspectOffice(Buffer.concat([officeFixture(mode), Buffer.alloc(padding)]), names[mode], mode));
    const crc = officeFixture(mode); crc[50] ^= 1; assert.throws(() => inspectOffice(crc, names[mode], mode));
  });
}
const record = { subject: 's', email: 'owner@example.invalid' };
const json = data => new Response(JSON.stringify(data));
test('review regression: passive embedded DOCX picture and PPTX table schema URIs are not network references', () => {
  const picture = uri => `<w:p><w:r><w:drawing xmlns:wp="${O}drawingml/2006/wordprocessingDrawing" xmlns:a="${A}" xmlns:pic="${O}drawingml/2006/picture"><wp:inline><a:graphic><a:graphicData uri="${uri}"><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const options = {
    types: '<Default Extension="png" ContentType="image/png"/>',
    extra: { 'word/media/image1.png': Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex'),
      'word/_rels/document.xml.rels': `<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="image1" Type="${R}/image" Target="media/image1.png"/></Relationships>` },
  };
  const doc = officeFixture('docx_to_doc', { ...options, body: picture(`${O}drawingml/2006/picture`) });
  assert.equal(inspectOffice(doc, 'image.docx', 'docx_to_doc').body.images, 1);
  for (const uri of ['https://example.invalid/asset', `${O}drawingml/2006/chart`]) assert.throws(() => inspectOffice(officeFixture('docx_to_doc', { ...options, body: picture(uri) }), 'image.docx', 'docx_to_doc'));
  const table = `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData uri="${O}drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Editable table</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;
  const ppt = inspectOffice(officeFixture('pptx_to_slides', { extra: { 'ppt/slides/slide1.xml': table } }), 'table.pptx', 'pptx_to_slides');
  assert.equal(ppt.slides[0].tables, 1); assert.equal(ppt.slides[0].textCharacters, 'Editable table'.length);
});
test('Docs readback compares bounded native main-body text/structure without exposing content; mismatch is not fidelity', async () => {
  let text = 'Hello editable world\n';
  const adapter = createUploadAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async (url, init) => {
    assert.match(String(url), /^https:\/\/docs.googleapis.com\/v1\/documents\/new\?includeTabsContent=true$/);
    assert.equal(init.method, undefined);
    return json({ documentId: 'new', tabs: [{ tabProperties: { tabId: 't1' }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } } }] });
  } });
  const expected = inspectOffice(officeFixture(), 'example.docx', 'docx_to_doc');
  const r = await adapter.inspectDoc(record, 'new', expected);
  assert.equal(r.structureMatches, true); assert.equal(r.fidelityVerified, false); assert.equal(r.paragraphs, 1); assert.doesNotMatch(JSON.stringify(r), /Hello editable|PRIVATE/);
  text = 'content omitted'; assert.equal((await adapter.inspectDoc(record, 'new', expected)).structureMatches, false);
  text = 'x'.repeat(80001); await assert.rejects(adapter.inspectDoc(record, 'new', expected));
});
test('Slides readback checks count/order and editable shape/table/group text; no thumbnail or remote asset fetches', async () => {
  let slides = [1,2].map(n => ({ objectId: `slide${n}`, pageElements: [{ objectId: `shape${n}`, shape: { text: { textElements: [{ textRun: { content: `Slide ${n} editable text\n` } }] } } }] }));
  const adapter = createUploadAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async (url, init) => {
    assert.match(String(url), /^https:\/\/slides.googleapis.com\/v1\/presentations\/new\?/); assert.equal(init.method, undefined);
    return json({ presentationId: 'new', slides });
  } });
  const expected = inspectOffice(officeFixture('pptx_to_slides'), 'example.pptx', 'pptx_to_slides');
  const r = await adapter.inspectSlides(record, 'new', expected);
  assert.equal(r.structureMatches, true); assert.equal(r.slideCount, 2); assert.equal(r.fidelityVerified, false); assert.doesNotMatch(JSON.stringify(r), /Slide [12] editable|PRIVATE/);
  slides.reverse(); assert.equal((await adapter.inspectSlides(record, 'new', expected)).textMatchesInOrder, false);
  slides.pop(); assert.equal((await adapter.inspectSlides(record, 'new', expected)).countMatches, false);
  slides = [{ objectId: 'slide1', pageElements: [{ objectId: 'dup' }, { objectId: 'dup' }] }]; await assert.rejects(adapter.inspectSlides(record, 'new', expected));
});
test('review regressions: PPTX soft line breaks normalize to preserved native whitespace; timeline commands cannot hide in slide XML', async () => {
  const slide = text => `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hello</a:t></a:r>${text}<a:r><a:t>world</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const expected = inspectOffice(officeFixture('pptx_to_slides', { extra: { 'ppt/slides/slide1.xml': slide('<a:br/>') } }), 'example.pptx', 'pptx_to_slides');
  const adapter = createUploadAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async () => json({ presentationId: 'new', slides: [
    { objectId: 's1', pageElements: [{ objectId: 'e1', shape: { text: { textElements: [{ textRun: { content: 'Hello\nworld\n' } }] } } }] },
    { objectId: 's2', pageElements: [{ objectId: 'e2', shape: { text: { textElements: [{ textRun: { content: 'Slide 2 editable text\n' } }] } } }] },
  ] }) });
  assert.equal((await adapter.inspectSlides(record, 'new', expected)).structureMatches, true);
  for (const content of ['<p:timing><p:tnLst><p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr/></p:cmd></p:tnLst></p:timing>', '<a:audioCd/>']) {
    assert.throws(() => inspectOffice(officeFixture('pptx_to_slides', { extra: { 'ppt/slides/slide1.xml': slide(content) } }), 'example.pptx', 'pptx_to_slides'), e => e.uploadCode === 'conversion');
  }
});
test('native API rejection/oversized readback is not silently verified or retried', async () => {
  for (const response of [() => new Response('PRIVATE_PROVIDER', { status: 403 }), () => new Response('x'.repeat(1048577))]) {
    let calls = 0;
    const adapter = createUploadAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(adapter.inspectDoc(record, 'new', { kind: 'doc' })); assert.equal(calls, 1);
  }
});
