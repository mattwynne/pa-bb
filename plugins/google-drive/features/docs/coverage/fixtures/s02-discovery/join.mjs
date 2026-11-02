// Reproducible bounded inventory join. Never edits original bridge fixture bytes.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expand } from '../../expand.mjs';
const coverage=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,coverage),'utf8'),json=p=>JSON.parse(read(p)),hash=x=>createHash('sha256').update(x).digest('hex');
const manifest=json('obligations.json'),records=expand(manifest).filter(r=>r.earliestSlice==='S02'&&['docs_inspect.kind','docs_inspect.tabs','docs_inspect.provenance','gdrive_get_file.metadata'].includes(r.operation));assert.equal(records.length,60);
const candidates=json('bridge-cases.json'),index=json('fixtures/index.json'),add=[];
let indexText=read('fixtures/index.json');
for(const r of records){if(index[r.caseId]){const entry=index[r.caseId];if(entry.path.includes('/s02-discovery/')){const bytes=readFileSync(new URL(`${r.caseId}.json`,import.meta.url)),next={...entry,sha256:hash(bytes),provenance:JSON.parse(bytes).provenance};indexText=indexText.replace(JSON.stringify(entry),JSON.stringify(next));}continue;}if(candidates[r.caseId]){add.push(candidates[r.caseId]);delete candidates[r.caseId];}else{const path=`features/docs/coverage/fixtures/s02-discovery/${r.caseId}.json`,bytes=readFileSync(new URL(`${r.caseId}.json`,import.meta.url));add.push({caseId:r.caseId,path,sha256:hash(bytes),provenance:JSON.parse(bytes).provenance});}}
// Preserve all unrelated descriptors and exact source formatting, append originals.
if(add.length)indexText=indexText.trimEnd().replace(/\n}\s*$/,',\n'+add.map(e=>'  '+JSON.stringify(e.caseId)+':'+JSON.stringify(e)).join(',\n')+'\n}')+'\n';
writeFileSync(new URL('fixtures/index.json',coverage),indexText);
writeFileSync(new URL('bridge-cases.json',coverage),JSON.stringify(candidates,null,2)+'\n');
const registry=json('registry.json'),ops={};for(const r of records){if(registry.operations[r.operation]?.variants?.[r.semanticVariant])continue;ops[r.operation]??={variants:{}};ops[r.operation].variants[r.semanticVariant]={driver:r.driver,schema:r.schema,requestedMode:r.requestedMode,capability:r.operation==='gdrive_get_file.metadata'?'native.gdrive_get_file.metadata':'native.docs_inspect',requests:r.requests};}
if(Object.keys(ops).length)writeFileSync(new URL('registry.json',coverage),read('registry.json').replace('  "operations": {','  "operations": {\n'+Object.entries(ops).map(([op,value])=>'    '+JSON.stringify(op)+':'+JSON.stringify(value)+',').join('\n')));
const overrides=records.filter(r=>!manifest.expansion.deliveryOverrides[r.key]).map(r=>`      ${JSON.stringify(r.key)}:${JSON.stringify({status:'delivered',evidence:r.caseId==='C001.nativeDoc__read.success'||r.caseId==='C165.fileMetadata__read.success'?'Original immutable bridge fixture/descriptor migrated at this exact key; fresh actual native execution and independent comparator.':'S02 discovery: original independent provider facts/expected envelope; actual application or existing native metadata entry, fixed native/HTTP/SQLite companions and current-run intake.'})}`);
if(overrides.length)writeFileSync(new URL('obligations.json',coverage),read('obligations.json').replace('    "deliveryOverrides": {','    "deliveryOverrides": {\n'+overrides.join(',\n')+','));
console.log(`Joined ${records.length} exact discovery keys, ${add.length} new descriptors. Review required before acceptance.`);
