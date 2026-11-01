// C006 uses the native docs_read structured registry path already implemented in
// A. It is diagnostic evidence, not C005 annotations, writable identities or a
// new public API. Shared capture/envelope comparisons retain their C005 tests.
import assert from 'node:assert/strict';
import {executeReadProgram,compareReadProgram} from './c005-execution.mjs';
const account='reader@example.test',snapshotId='snap-d';
const categories={styles:['styles','lists'],objects:['objects','diagnostics'],ranges:['ranges'],suggestions:['review']};
export function* structureProgram(f){
 const state=()=>({op:'state'});
 function* read(args,expect='page',role='primary'){const result=yield {op:'native',name:'docs_read',args,expect,role};yield state();return result;}
 function* finish(result,role='primary'){let count=0;while(!result.complete){assert.ok(++count<20,'bounded C006 continuation');result=yield* read({account,snapshotId,cursor:result.nextCursor},'page',role);}return result;}
 yield state();yield {op:'native',name:'docs_inspect',args:f.inspect,expect:'inspect'};yield state();yield {op:'get'};
 if(f.outcome==='invalid')yield* read({...f.read,registries:[...f.read.registries,`future-${f.variant}`]},'schema');
 if(f.outcome==='wrongSubject')yield* read({...f.read,account:'other@example.test'},'snapshot');
 if(f.controlRead)yield* finish(yield* read(f.controlRead,'page','control'),'control');
 if(f.outcome==='bounds'){yield* read(f.read,'budget');yield* read(f.read,'budget');}
 else {
  const first=yield* read(f.read);
  if(f.outcome==='wrongSubject'){assert.equal(first.complete,false);yield* read({account:'other@example.test',snapshotId,cursor:first.nextCursor},'snapshot');}
  yield* finish(first);
 }
 yield {op:'get'};yield state();
}
export async function executeC006(record,fixture,inventory){return executeReadProgram(record,fixture,inventory,structureProgram);}
export function compareC006(record,f,t){
 assert.equal(record.ledgerId,'C006');assert.equal(record.operation,'docs_read.structure');assert.equal(record.requestedMode,'read');assert.equal(f.caseId,record.caseId);assert.equal(f.variant,record.base);assert.equal(f.outcome,record.outcomeVariant);
 assert.ok(Object.hasOwn(categories,f.variant));assert.ok(['success','invalid','preservation','bounds','wrongSubject'].includes(f.outcome));
 assert.equal(f.pageBytes,f.outcome==='bounds'?65536:6000);assert.equal(f.provider.document.revisionId,'rev-c006');assert.deepEqual(t.providerAfter,f.provider);
 assert.equal(f.read.format,'structured');assert.deepEqual(f.read.registries,categories[f.variant]);assert.ok(f.expected.registryEntries.length);assert.ok(Array.isArray(f.expected.registryReferences));
 assert.equal(f.expected.projection.projection,'diagnostic');assert.ok(f.expected.projection.records.some(r=>r.diagnosticOnly),'C006 readable definitions, not counts');
 assert.ok(f.expected.projection.records.every(r=>!f.expected.selectedIds.includes(r.id)),'registry handles never replace semantic node identities');
 for(const aspects of Object.values(f.expected.projection.nodeAspects))assert.ok(!aspects.includes('content'),'registry diagnostics cannot prove body content');
 compareReadProgram(record,f,t,structureProgram);
 const pages=t.nativeCalls.filter(c=>c.name==='docs_read'&&c.result&&!c.result.isError).map(c=>JSON.parse(c.result.content[0].text));
 assert.ok(pages.length,'C006 actual valid-side read required');
 if(f.outcome!=='bounds')assert.ok(pages.length>=2&&pages[0].complete===false&&pages.at(-1).complete===true,'C006 actual bounded registry continuation');
 for(const page of pages){assert.ok(page.coverage.missingAspects.includes('content'));assert.equal(page.coverage.editReady,false);assert.ok(page.records.every(r=>r.kind!=='documentSummary'),'C006 cannot substitute inspection counts');}
 if(f.variant==='suggestions'&&f.commentsDenied)for(const page of pages){assert.equal(page.coverage.missingReviewCoverage,true);assert.ok(page.coverage.missingAspects.includes('review'));}
 return true;
}
