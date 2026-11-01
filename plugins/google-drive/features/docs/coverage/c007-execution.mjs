// C007 reads actual physical cells through existing node/span selectors. Paths
// identify authored targets; native handles are obtained from the genuine stored
// snapshot, not invented from labels or used as future table/cell edit selectors.
import assert from 'node:assert/strict';
import {executeReadProgram,compareReadProgram} from './c005-execution.mjs';
const account='reader@example.test',snapshotId='snap-d';
function bind(model,paths){
 const handle=path=>{const found=Object.values(model.nodes).filter(n=>JSON.stringify(n.evidence.path)===JSON.stringify(path));assert.equal(found.length,1,'C007 exact observed snapshot path');return found[0].id;};
 return paths.node?{node:handle(paths.node)}:{span:{from:handle(paths.span.from),to:handle(paths.span.to)}};
}
export function* richProgram(f){
 const state=()=>({op:'state'});
 function* read(args,expect='page',role='primary'){const result=yield {op:'native',name:'docs_read',args,expect,role};yield state();return result;}
 function* finish(result,role='primary'){let count=0;while(!result.complete){assert.ok(++count<30,'C007 bounded actual continuation');result=yield* read({account,snapshotId,cursor:result.nextCursor},'page',role);}return result;}
 yield state();yield {op:'native',name:'docs_inspect',args:f.inspect,expect:'inspect'};yield state();const model=yield {op:'get'};
 const args={...f.read,selector:bind(model,f.mainPaths)};assert.deepEqual(args.selector,f.read.selector,'C007 authored target matches observed handle');
 if(f.outcome==='invalid')yield* read({...args,selector:bind(model,f.invalidPaths)},'scope');
 if(f.outcome==='wrongSubject')yield* read({...args,account:'other@example.test'},'snapshot');
 if(f.controlRead){const control={...f.controlRead,selector:bind(model,f.controlPaths)};assert.deepEqual(control.selector,f.controlRead.selector);yield* finish(yield* read(control,'page','control'),'control');}
 if(f.outcome==='bounds'){yield* read(args,'budget');yield* read(args,'budget');}
 else{const first=yield* read(args);assert.equal(first.complete,false,'C007 actual partial rich-cell page');if(f.outcome==='wrongSubject')yield* read({account:'other@example.test',snapshotId,cursor:first.nextCursor},'snapshot');yield* finish(first);}
 yield {op:'get'};yield state();
}
export async function executeC007(record,fixture,inventory){return executeReadProgram(record,fixture,inventory,richProgram);}
export function compareC007(record,f,t){
 assert.equal(record.ledgerId,'C007');assert.equal(record.operation,'docs_read.richCell');assert.equal(record.requestedMode,'read');assert.equal(f.caseId,record.caseId);assert.equal(f.variant,record.base);assert.equal(f.outcome,record.outcomeVariant);
 assert.ok(['adjacentRuns','inlineObject','nestedTable','paragraphNewlines'].includes(f.variant));assert.ok(['success','invalid','preservation','bounds','wrongSubject'].includes(f.outcome));
 assert.equal(f.pageBytes,f.outcome==='bounds'?65536:6000);assert.equal(f.provider.document.revisionId,'rev-c007');assert.deepEqual(t.providerAfter,f.provider);assert.equal(f.read.format,['adjacentRuns','paragraphNewlines'].includes(f.variant)?'text':'structured');assert.equal(f.read.styles,true);assert.equal(f.read.registries,undefined);
 assert.ok(Array.isArray(f.expected.registryEntries)&&Array.isArray(f.expected.registryReferences));
 const model=t.localCalls.find(c=>c.operation==='snapshot.get')?.result;assert.ok(model,'C007 missing actual model');
 const cell=model.nodes[bind(model,{node:f.cellPath}).node];assert.equal(cell.kind,'tableCell','C007 feature must be inside a real table cell');const row=model.nodes[cell.parent],table=model.nodes[row.parent];assert.equal(row.kind,'tableRow');assert.equal(table.kind,'table');assert.ok(table.grid[cell.origin.row].includes(cell.id));
 for(const key of f.expected.selectedIds){let n=model.nodes[key];assert.ok(n);while(n&&n.id!==cell.id)n=model.nodes[n.parent];assert.equal(n?.id,cell.id,'C007 every selected semantic node stays in the physical cell');}
 const bad=bind(model,f.invalidPaths).span,a=model.nodes[bad.from],b=model.nodes[bad.to];assert.equal(a.parent,b.parent);const siblings=model.nodes[a.parent].children;assert.ok(siblings.indexOf(a.id)>siblings.indexOf(b.id),'C007 actual invalid reversed sibling span');
 compareReadProgram(record,f,t,richProgram);
 for(const c of t.nativeCalls.filter(c=>c.name==='docs_read'&&c.result&&!c.result.isError)){
  const page=JSON.parse(c.result.content[0].text);assert.equal(page.coverage.editReady,false);
  if(f.read.format==='text')assert.ok(page.coverage.delivered.nodes.every(key=>model.nodes[key]?.kind==='text'),'C007 text cannot claim parent/cell structural delivery');
  assert.ok(page.coverage.delivered.nodes.every(key=>!f.expected.unselectedIds.includes(key)),'C007 neighbor cells remain undelivered');
 }
 return true;
}
