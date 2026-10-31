import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectXlsx } from '../adapters/xlsx-import.mjs';
import { inspectOffice } from '../adapters/office-import.mjs';
import { createUploadSource } from '../adapters/upload-source.mjs';
import { officeFixture } from './office-fixtures.mjs';
const O='http://schemas.openxmlformats.org/', R=O+'officeDocument/2006/relationships', S=O+'spreadsheetml/2006/main';
function workbook({parts={},types='',sheet='',relationships=''}={}) {
  const files={
    '[Content_Types].xml':`<Types xmlns="${O}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${types}</Types>`,
    '_rels/.rels':`<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="main" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Budget" sheetId="1" r:id="sheet1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="sheet1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>SUM(A1:A1)</f><v>1</v></c></row></sheetData>${sheet}</worksheet>`,
    ...(relationships ? {'xl/worksheets/_rels/sheet1.xml.rels':`<Relationships xmlns="${O}package/2006/relationships">${relationships}</Relationships>`} : {}), ...parts,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,typeof bytes==='string'?strToU8(bytes):bytes]))));
}
const reject=bytes=>assert.throws(()=>inspectXlsx(bytes,'fixture.xlsx'),e=>e.uploadCode==='conversion');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('ensemble F1: a linked renamed embedded DOCX is rejected independently of conventional embedding directories',()=>{
  const nested=officeFixture('docx_to_doc',{body:'<w:fldSimple w:instr="DDEAUTO example"/>'});
  const original=Buffer.from(nested); assert.throws(()=>inspectOffice(nested,'nested.docx','docx_to_doc'));
  const bytes=workbook({parts:{'xl/objects/document.docx':nested},types:'<Override PartName="/xl/objects/document.docx" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/>',sheet:'<oleObjects><oleObject progId="Word.Document.12" r:id="object1" shapeId="1"/></oleObjects>',relationships:`<Relationship Id="object1" Type="${R}/package" Target="../objects/document.docx"/>`});
  reject(bytes); assert.deepEqual(nested,original);
});
test('package/OLE relationship and use checks reject even when target is an otherwise eligible passive part',()=>{
  const common={parts:{'xl/media/image1.png':png},types:'<Default Extension="png" ContentType="image/png"/>'};
  for(const rel of ['package','Package','package ','oleObject']) reject(workbook({...common,relationships:`<Relationship Id="p" Type="${R}/${rel}" Target="../media/image1.png"/>`}));
  for(const tag of ['oleObject','oleObjects','embeddedObject','embeddedPackage','control','controls']) reject(workbook({...common,sheet:`<${tag} r:id="p"/>`,relationships:`<Relationship Id="p" Type="${R}/image" Target="../media/image1.png"/>`}));
});
test('unreferenced or disguised opaque parts and unsupported even-unused binary declarations fail closed',()=>{
  const nested=officeFixture();
  for(const path of ['xl/objects/payload.docx','xl/custom/payload.bin','xl/media/payload.docx','xl/media/payload.png']) reject(workbook({parts:{[path]:nested}}));
  for(const type of ['application/zip','application/octet-stream','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.presentationml.presentation']) {
    reject(workbook({types:`<Default Extension="bin" ContentType="${type}"/>`}));
    reject(workbook({types:`<Override PartName="/xl/custom/unused.bin" ContentType="${type}"/>`}));
  }
});
test('ordinary formulas/tabs and declared passive PNG/JPEG/GIF remain accepted without changing source bytes',()=>{
  const media=[['png','image/png',png],['jpg','image/jpeg',Buffer.from([255,216,255,224,0,0])],['gif','image/gif',Buffer.from('GIF89a000000')]];
  for(const [ext,type,bytes]of media) for(const declaration of [`<Default Extension="${ext}" ContentType="${type}"/>`,`<Override PartName="/xl/media/image1.${ext}" ContentType="${type}"/>`]) {
    const input=workbook({parts:{[`xl/media/image1.${ext}`]:bytes},types:declaration,relationships:`<Relationship Id="image" Type="${R}/image" Target="../media/image1.${ext}"/>`}), before=Buffer.from(input);
    const result=inspectXlsx(input,'fixture.xlsx'); assert.deepEqual(result.tabs,['Budget']); assert.equal(result.sourceFormulaCount,1); assert.deepEqual(input,before);
  }
  reject(workbook({parts:{'xl/media/image1.png':png}}));
  reject(workbook({parts:{'xl/media/image1.png':png},types:'<Override PartName="/xl/media/image1.png" ContentType="image/jpeg"/>'}));
  const highBitGif=Buffer.from('GIF89a'); highBitGif[0]|=128;
  reject(workbook({parts:{'xl/media/image1.gif':highBitGif},types:'<Default Extension="gif" ContentType="image/gif"/>'}));
});
test('explicit binary capture remains opaque and byte-preserving for a conversion-refused workbook',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xlsx-refused-binary-'));
  try {
    const bytes=workbook({parts:{'xl/custom/payload.bin':Buffer.from('untrusted opaque fixture')}}), digest=createHash('sha256').update(bytes).digest('hex');
    reject(bytes); await writeFile(join(root,'fixture.xlsx'),bytes);
    const source=createUploadSource({location:async()=>root}), ref={host:'bb-server',threadId:'thr_fixture',path:'fixture.xlsx'};
    await assert.rejects(source.capture(ref,digest,'xlsx_to_sheet'),e=>e.uploadCode==='conversion');
    assert.deepEqual((await source.capture(ref,digest,'binary')).bytes,bytes); assert.deepEqual(await readFile(join(root,'fixture.xlsx')),bytes);
  }finally{await rm(root,{recursive:true,force:true});}
});
