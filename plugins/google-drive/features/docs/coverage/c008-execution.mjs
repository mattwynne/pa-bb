// C008 uses the same fixed native capture and parent comparison as C005–C007.
// Readable opaque API evidence is not rendered/calculated or authoring evidence.
import assert from 'node:assert/strict';import {executeReadProgram,compareReadProgram} from './c005-execution.mjs';
function bind(model,paths){const handle=path=>{const n=Object.values(model.nodes).filter(n=>JSON.stringify(n.evidence.path)===JSON.stringify(path));assert.equal(n.length,1,'C008 exact observed snapshot path');return n[0].id;};return paths.node?{node:handle(paths.node)}:{span:{from:handle(paths.span.from),to:handle(paths.span.to)}};}
function* opaqueProgram(f){
 const state=()=>({op:'state'}),account='reader@example.test',snapshotId='snap-d';
 function* read(args,expect='page',role='primary'){const r=yield {op:'native',name:'docs_read',args,expect,role};yield state();return r;}
 function* finish(r,role){let pages=0;while(!r.complete){assert.ok(++pages<30,'C008 bounded actual continuation');r=yield* read({account,snapshotId,cursor:r.nextCursor},'page',role);}return r;}
 yield state();yield {op:'native',name:'docs_inspect',args:f.inspect,expect:'inspect'};yield state();const model=yield {op:'get'};
 const args={...f.read,selector:bind(model,f.mainPaths)},control={...f.controlRead,selector:bind(model,f.controlPaths)};assert.deepEqual(args.selector,f.read.selector);assert.deepEqual(control.selector,f.controlRead.selector);
 if(f.outcome==='invalid')yield* read({...control,selector:bind(model,f.invalidPaths)},'scope');
 if(f.outcome==='wrongSubject')yield* read({...args,account:'other@example.test'},'snapshot');
 yield* finish(yield* read(control,'page','control'),'control');
 if(f.variant==='unknown'){const extra={...f.extraRead,selector:bind(model,f.extraPaths)};assert.deepEqual(extra.selector,f.extraRead.selector);yield* finish(yield* read(extra,'page','opaqueControl'),'opaqueControl');}
 if(f.outcome==='bounds'){yield* read(args,'budget');yield* read(args,'budget');}
 else{const first=yield* read(args);assert.equal(first.complete,false,'C008 actual partial opaque evidence');if(f.outcome==='wrongSubject')yield* read({account:'other@example.test',snapshotId,cursor:first.nextCursor},'snapshot');yield* finish(first,'primary');}
 yield {op:'get'};yield state();
}
export async function executeC008(record,f,inventory){return executeReadProgram(record,f,inventory,opaqueProgram);}
export function compareC008(record,f,t){
 assert.equal(record.ledgerId,'C008');assert.equal(record.operation,'docs_read.opaque');assert.equal(record.requestedMode,'read');assert.equal(record.caseId,f.caseId);assert.equal(record.base,f.variant);assert.equal(record.outcomeVariant,f.outcome);
 assert.ok(['autoText','drawing','equation','toc','unknown'].includes(f.variant));assert.ok(['success','invalid','preservation','bounds','wrongSubject'].includes(f.outcome));assert.equal(f.pageBytes,f.outcome==='bounds'?65536:6000);assert.equal(f.provider.document.revisionId,'rev-c008');assert.deepEqual(t.providerAfter,f.provider);assert.equal(f.read.format,'structured');assert.equal(f.read.styles,true);assert.equal(f.controlRead.format,'text');
 assert.deepEqual(f.read.registries,{drawing:['objects'],unknown:['diagnostics']}[f.variant]);
 if(f.variant==='unknown'){assert.equal(f.extraRead.format,'structured');assert.equal(f.extraRead.registries,undefined);assert.ok(f.expected.extraProjection.losses.some(l=>l.kind==='unknownFieldOmitted'));assert.deepEqual(f.expected.extraProjection.aspects,[]);}else assert.equal(f.extraRead,undefined);
 const model=t.localCalls.find(c=>c.operation==='snapshot.get')?.result;assert.ok(model,'C008 missing actual model');assert.deepEqual(model.unknownFields,f.expected.unknownFields,'C008 original unknown paths/digests');assert.equal(model.unresolvedExtents,true,'C008 unselected unresolved evidence remains retained');
 const feature=model.nodes[bind(model,{node:f.featurePath}).node];assert.equal(feature.kind,{autoText:'autoText',drawing:'inlineObjectElement',equation:'equation',toc:'toc',unknown:'opaque'}[f.variant]);
 if(f.variant==='drawing')assert.equal(feature.objectKind,'unknown');if(f.variant==='equation')assert.equal(feature.style,undefined,'C008 equation is not a text-style owner');if(f.variant==='autoText'){assert.equal(feature.properties.type,'PAGE_NUMBER');assert.equal(feature.text,undefined);}
 const reverse=bind(model,f.invalidPaths).span,forward=bind(model,f.controlPaths).span;assert.deepEqual(reverse,{from:forward.to,to:forward.from});const a=model.nodes[reverse.from],b=model.nodes[reverse.to];assert.equal(a.parent,b.parent);const siblings=model.nodes[a.parent].children;assert.ok(siblings.indexOf(a.id)>siblings.indexOf(b.id));
 assert.ok(f.expected.controlProjection.losses.some(l=>l.kind==='nonText'),'C008 actual loss-aware valid control');assert.ok(f.expected.unselectedIds.every(id=>!f.expected.selectedIds.includes(id)&&!f.expected.controlIds.includes(id)));
 compareReadProgram(record,f,t,opaqueProgram);
 for(const c of t.nativeCalls.filter(c=>c.name==='docs_read'&&c.result&&!c.result.isError)){const page=JSON.parse(c.result.content[0].text);assert.equal(page.coverage.editReady,false);assert.ok(page.coverage.delivered.nodes.every(id=>!f.expected.unselectedIds.includes(id)));}
 return true;
}
