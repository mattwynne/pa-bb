// Explicit native segment reads through the reviewed fixed capture/read pipeline.
import assert from 'node:assert/strict';import {executeReadProgram,compareReadProgram} from './c005-execution.mjs';
function nodeAt(model,path){const found=Object.values(model.nodes).filter(n=>JSON.stringify(n.evidence.path)===JSON.stringify(path));assert.equal(found.length,1,'C003 exact actual source path');return found[0];}
function* segmentProgram(f){
 const state=()=>({op:'state'}),account='reader@example.test',snapshotId='snap-d';
 function* read(args,expect='page',role='primary'){const r=yield {op:'native',name:'docs_read',args,expect,role};yield state();return r;}
 function* finish(r,role){let count=0;while(!r.complete){assert.ok(++count<30);r=yield* read({account,snapshotId,cursor:r.nextCursor},'page',role);}return r;}
 yield state();yield {op:'native',name:'docs_inspect',args:f.inspect,expect:'inspect'};yield state();const model=yield {op:'get'},main=nodeAt(model,f.mainPath),control=nodeAt(model,f.controlPath);
 assert.deepEqual(f.read.scope,{tabs:{ids:[main.tabId]},segments:[main.segment]});assert.equal(control.id,f.controlRead.selector.node);
 if(f.outcome==='invalid')yield* read(f.invalidRead,'scope');
 if(f.outcome==='wrongSubject')yield* read({...f.read,account:'other@example.test'},'snapshot');
 yield* finish(yield* read({...f.controlRead,selector:{node:control.id}},'page','control'),'control');
 const args={...f.read,selector:{node:main.id}};assert.deepEqual(args,f.read);const first=yield* read(args);assert.equal(first.complete,false,'C003 actual segment continuation');
 if(f.outcome==='wrongSubject')yield* read({account:'other@example.test',snapshotId,cursor:first.nextCursor},'snapshot');
 if(f.outcome==='bounds'){yield* read({account,snapshotId,cursor:first.nextCursor},'budget');yield* read({account,snapshotId,cursor:first.nextCursor},'budget');}
 else yield* finish(first,'primary');
 yield {op:'get'};yield state();
}
export async function executeC003(record,f,inventory){return executeReadProgram(record,f,inventory,segmentProgram);}
export function compareC003(record,f,t){
 assert.equal(record.ledgerId,'C003');assert.equal(record.operation,'docs_read.segment');assert.equal(record.requestedMode,'read');assert.equal(record.caseId,f.caseId);assert.equal(record.base,f.variant);assert.equal(record.outcomeVariant,f.outcome);assert.ok(['body','header','footer','footnote'].includes(f.variant));assert.ok(['success','invalid','preservation','bounds','wrongSubject'].includes(f.outcome));assert.equal(f.pageBytes,f.outcome==='bounds'?65536:6000);assert.equal(f.provider.document.revisionId,'rev-c003');assert.deepEqual(t.providerAfter,f.provider);assert.equal(f.read.format,'structured');assert.equal(f.read.styles,true);assert.equal(f.read.registries,undefined);
 const m=t.localCalls.find(c=>c.operation==='snapshot.get')?.result;assert.ok(m,'C003 missing actual model');assert.deepEqual(m.tabs.map(({providerId,title,parent,ordinal,segments})=>({providerId,title,parent,ordinal,segments})),f.expected.tabs,'C003 exact tab/segment inventory');assert.deepEqual(m.unknownFields,[]);assert.equal(m.unresolvedExtents,false);
 const main=nodeAt(m,f.mainPath);assert.equal(main.kind,'segment');assert.deepEqual(f.read.selector,{node:main.id});assert.equal(main.tabId,'tab-d');assert.equal(m.tabs[1].providerId,'tab-d');assert.equal(main.segment.kind,f.variant);assert.deepEqual(f.read.scope,{tabs:{ids:['tab-d']},segments:[main.segment]});assert.deepEqual(f.inspect.scope,f.read.scope);
 for(const s of f.expected.segments){const n=nodeAt(m,s.path);assert.equal(n.id,s.root);assert.equal(n.kind,'segment');assert.equal(n.tabId,s.tabId);assert.deepEqual(n.segment,s.segment);let raw=f.provider.document;for(const k of s.path)raw=raw[k];if(s.segment.id)assert.equal(raw[s.segment.kind+'Id'],s.segment.id);}
 for(const relation of f.expected.relationships){const ref=m.nodes[relation.reference],content=m.nodes[relation.contentRoot];assert.equal(ref.kind,'footnoteReference');assert.equal(ref.tabId,relation.tabId);assert.deepEqual(ref.segment,{kind:'body'});assert.equal(ref.properties.footnoteId,relation.footnoteId);assert.equal(content.kind,'segment');assert.equal(content.tabId,relation.tabId);assert.deepEqual(content.segment,{kind:'footnote',id:relation.footnoteId});assert.ok(!f.expected.selectedIds.includes(ref.id)||!f.expected.selectedIds.includes(content.id),'C003 reference is not footnote content');}
 const desc=id=>[id,...m.nodes[id].children.flatMap(desc)];assert.deepEqual(f.expected.selectedIds,desc(main.id));assert.deepEqual(f.expected.controlIds,desc(nodeAt(m,f.controlPath).id));
 if(f.variant==='body'){assert.equal(m.nodes[f.expected.foreignBodyId].tabId,'tab-a');assert.deepEqual(f.invalidRead.scope.segments,[{kind:'body'},{kind:'body'}]);assert.ok(f.expected.controlProjection.losses.some(l=>l.sourceKind==='footnoteReference'));}else{assert.equal(f.invalidRead.scope.segments[0].kind,f.variant);assert.ok(!m.tabs[1].segments.some(id=>m.nodes[id].segment.kind===f.variant&&m.nodes[id].segment.id===f.invalidRead.scope.segments[0].id));}
 if(f.variant==='footnote'){assert.equal(f.controlRead.format,'structured');assert.equal(f.controlRead.selector.node,f.expected.relationships[1].reference);}else assert.equal(f.controlRead.format,'text');
 compareReadProgram(record,f,t,segmentProgram);
 for(const c of t.nativeCalls.filter(c=>c.name==='docs_read'&&c.result&&!c.result.isError)){const p=JSON.parse(c.result.content[0].text);assert.equal(p.coverage.editReady,false);assert.ok(p.coverage.delivered.nodes.every(id=>!f.expected.unselectedIds.includes(id)));}
 return true;
}
