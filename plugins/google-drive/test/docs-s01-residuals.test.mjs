import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readManifest} from '../features/docs/coverage/control.mjs';
import {expand,allClosures,exposureClosure} from '../features/docs/coverage/expand.mjs';
import {auditEvidence} from '../features/docs/coverage/audit.mjs';
import {breakStructure,modeProbes} from '../features/docs/coverage/structure-probes.mjs';
import {weightedFontProbe} from '../features/docs/coverage/wire-probes.mjs';
import {validateRequest} from '../features/docs/coverage/wire.mjs';
import {DocsWorld} from '../features/docs/support/world.mjs';
const vectors=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/residual-vectors.json',import.meta.url)));
const legacy=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/legacy-vectors.json',import.meta.url)));
const reasons={
  validationUnknown:/unknown mode/,validationEmpty:/empty\/missing mode list/,validationDuplicate:/duplicate mode/,
  validationUnavailable:/unavailable same-mode validation control/,
  fixedEmpty:/empty\/missing mode list/,fixedUnknown:/unknown mode/,fixedDuplicate:/duplicate mode/,fixedUnavailable:/fixed-mode control unavailable/,
  policyEmpty:/empty\/missing mode list/,policyUnknown:/unknown mode/,policyDuplicate:/duplicate mode/,policyIllegal:/illegal mode/,
  variantEmpty:/empty\/missing mode list/,variantUnknown:/unknown mode/,variantIllegal:/illegal mode/,variantDuplicate:/duplicate mode/,variantMapEmpty:/empty\/missing mode list/,
  nonwriterUnavailable:/fixed-mode nonwriter route unavailable/,controlMissing:/missing same-mode route\/control/,
};
assert.deepEqual(Object.keys(reasons).sort(),Object.keys(modeProbes).sort());
for(const [probe,reason]of Object.entries(reasons))test(`residual mode declarations reject ${probe} without exposure`,()=>{
  const manifest=readManifest();breakStructure(manifest,probe);
  assert.throws(()=>expand(manifest),reason);
  assert.throws(()=>auditEvidence({manifest,registry:{operations:{},exposed:[]},cases:[],results:[],fixtures:{},root:'/tmp',runId:'negative'}),reason);
});
test('every approved intended base resolves, inventory and 314-key closure preserved',()=>{
  const m=readManifest(),records=expand(m);
  for(const [id,row]of Object.entries(m.rows))for(const group of row.groups)for(const base of group.variants)
    assert.ok(records.some(r=>r.ledgerId===id&&r.operation===group.operation&&r.base===base),`${id}/${base}`);
  assert.equal(Object.keys(m.rows).length,211);assert.equal(records.length,11197);
  assert.equal(allClosures(m,records).size,1036);assert.equal(exposureClosure(m,records,'docs_plan_style.text/bold__direct').length,314);
});
for(const context of ['text','named']){
  for(const weight of ['default','100','200','300','400','500','600','700','800','900'])test(`weighted font ${context}/${weight} is independently valid`,()=>{
    const v=weightedFontProbe(context,weight);assert.doesNotThrow(()=>validateRequest(v.request,v.effects));
  });
  for(const weight of ['zero','offStep','tooHigh','fraction','string','null','boolean'])test(`weighted font ${context}/${weight} rejects supplied invalid value`,()=>{
    const v=weightedFontProbe(context,weight);assert.throws(()=>validateRequest(v.request,v.effects),['zero','offStep','tooHigh'].includes(weight)?/font weight domain/:/number type/);
  });
  test(`weighted font ${context} rejects nonfinite values`,()=>{
    for(const value of [NaN,Infinity,-Infinity]){
      const v=weightedFontProbe(context,'default'),style=context==='text'?v.request.updateTextStyle.textStyle:v.request.updateNamedStyle.namedStyle.textStyle;
      style.weightedFontFamily.weight=value;assert.throws(()=>validateRequest(v.request,v.effects),/number type/);
    }
  });
}
const url='https://docs.googleapis.com/v1/documents/doc-a:batchUpdate';
for(const [name,body]of Object.entries(vectors.batches))test(`swallowed batch ${name} journals exactly once and fails teardown while closing SQLite`,async()=>{
  const w=new DocsWorld();await w.init();const db=w.host.bb.storage.database();
  try{
    await assert.rejects(()=>w.fetch(url,{method:'POST',body:JSON.stringify(body)}));
    assert.deepEqual(w.unexpected,[{wire:'invalid batch'}]);
    await assert.rejects(()=>w.close(),e=>e.message==='closed-network teardown failed'&&e.errors.length===1);
    assert.equal(db.open,false);
    assert.throws(()=>w.acknowledgeHttpFault({wire:'wrong fault'}),/only the exact/);
    w.acknowledgeHttpFault({wire:'invalid batch'});
  }finally{await w.close();}
});
for(const fault of ['reject400','reject403'])test(`legitimate provider ${fault} is not a fixture contract fault`,async()=>{
  const w=new DocsWorld();await w.init(fault);const db=w.host.bb.storage.database();
  try{
    const response=await w.fetch(url,{method:'POST',body:JSON.stringify(legacy.format.request)});
    assert.equal(response.status,Number(fault.slice(6)));assert.deepEqual(w.unexpected,[]);
  }finally{await w.close();}
  assert.equal(db.open,false);
});
test('one malformed HTTP acknowledgement never excuses a later malformed batch',async()=>{
  const w=new DocsWorld();await w.init();const db=w.host.bb.storage.database();
  try{
    await assert.rejects(()=>w.fetch(url,{method:'POST',body:'null'}));
    assert.deepEqual(w.unexpected,[{wire:'invalid batch'}]);w.acknowledgeHttpFault({wire:'invalid batch'});
    await assert.rejects(()=>w.fetch(url,{method:'POST',body:'{}'}));
    assert.deepEqual(w.unexpected,[{wire:'invalid batch'}]);
    await assert.rejects(()=>w.close(),/closed-network teardown failed/);assert.equal(db.open,false);
    w.acknowledgeHttpFault({wire:'invalid batch'});
  }finally{await w.close();}
});
