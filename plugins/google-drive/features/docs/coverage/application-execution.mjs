// Fixed real-application execution. No SDK, SQL, processes or copied package.
// Existing instruction programs are shared, independent fixture answers are not
// replaced. Native/SQL assertions remain in mandatory integration companions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSemanticReadService } from '../../../core/docs-semantic/application.mjs';
import { resolveSelector } from '../../../core/docs-semantic/selectors.mjs';
import { footprint,evaluateWitness } from '../../../core/docs-semantic/coverage.mjs';
import { describeSemanticFailure } from '../../../core/docs-semantic/failures.mjs';
import { digest,semanticError } from '../../../core/docs-semantic/common.mjs';
import { SEMANTIC_READ_SCHEMAS } from '../../../docs-semantic-schemas.mjs';
import { createMemorySnapshots } from '../support/memory-snapshots.mjs';
import { assertIndependentModel,expectedInspection } from './application-expectations.mjs';
import { projectionProgram } from './c005-execution.mjs';
import { segmentProgram } from './c003-execution.mjs';
import { structureProgram } from './c006-execution.mjs';
import { richProgram } from './c007-execution.mjs';
import { opaqueProgram } from './c008-execution.mjs';
import { viewProgram } from './c010-execution.mjs';
import { reviewProgram } from './c011-execution.mjs';
import { findProgram as literalProgram } from './c012-execution.mjs';
import { findProgram as normalizationProgram } from './c013-execution.mjs';
import { program as cardinalityProgram } from './c015-execution.mjs';
const programs={C003:segmentProgram,C005:projectionProgram,C006:structureProgram,C007:richProgram,C008:opaqueProgram,C010:viewProgram,C011:reviewProgram,C012:literalProgram,C013:normalizationProgram,C015:cardinalityProgram};
export const applicationFamily=record=>!record.bridgeCandidate&&Object.hasOwn(programs,record.ledgerId)&&(record.requestedMode==='read'||record.ledgerId==='C015'&&record.requestedMode==='local');
const owner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'},id='snap-d',bytes=x=>Buffer.byteLength(JSON.stringify(x));
export function applicationBoundary(record){assert.ok(applicationFamily(record),'no fixed application executor');return {layer:'application',entryPoint:record.ledgerId==='C015'?'resolveSelector + createSemanticReadService':'createSemanticReadService',ports:{snapshots:'memory/logical-only',authority:'scripted',document:'scripted-observation'},companions:['semantic-native-read','semantic-sqlite-contract','semantic-http-contract']};}
export async function executeApplication(record,f){
  const boundary=applicationBoundary(record),memory=createMemorySnapshots();let now=0,identity=0,model;
  const docsCalls=[],events=[],logs=[];
  const accounts=new Map([[owner.account,{subject:owner.subject,email:owner.account}],['other@example.test',{subject:'subject-other',email:'other@example.test'}]]);
  const store={semanticSnapshots:memory.port,byEmail:async account=>accounts.get(account)};
  const docs={authority:async r=>{docsCalls.push({operation:'authority',subject:r.subject});},metadata:async()=>{docsCalls.push({operation:'metadata'});return structuredClone(f.provider.metadata);},read:async(r,documentId,view,signal,{includeReview})=>{
    docsCalls.push({operation:'read',view,includeReview});if(f.commentsDenied&&includeReview)throw Object.assign(semanticError('denied'),{status:403});
    const document=structuredClone(f.provider.responses?.[view]??f.provider.document);
    return {document,responseDigest:digest(JSON.stringify(document)),responseBytes:bytes(document),reviewIncluded:includeReview&&view==='inline'};
  }};
  const service=createSemanticReadService({store,docs,clock:()=>now,ids:()=>++identity===1?id:`read-d-${identity}`,pageBytes:f.pageBytes,diagnose:(stage,error)=>logs.push({stage,category:error.semanticCode})});
  const plan=programs[record.ledgerId](f);let step=plan.next();
  while(!step.done){const a=step.value,event={id:randomUUID(),instruction:structuredClone(a),clock:now};let value;
    try{
      if(a.op==='state')value=memory.observeDetailed();
      else if(a.op==='advance'){now=a.to;value=now;}
      else if(a.op==='get'){value=store.semanticSnapshots.get(id,a.owner??owner,now);model??=value;}
      else if(a.op==='resolve')value=resolveSelector(model,a.q.args.scope,a.q.args.selector);
      else if(a.op==='coverage'||a.op==='reviewCoverage'){
        const snapshot=store.semanticSnapshots.get(id,owner,now),deliveries=store.semanticSnapshots.deliveries(id,owner,now,a.tokens);
        value=evaluateWitness(snapshot,footprint(snapshot,a.spec),{deliveries});
      }else{
        const parsed=SEMANTIC_READ_SCHEMAS[a.name].safeParse(a.args);
        if(!parsed.success){event.error={category:'schema'};value=null;}
        else try{value=JSON.parse(JSON.stringify(await service[{docs_inspect:'inspect',docs_read:'read',docs_find:'find'}[a.name]](parsed.data,owner.threadId)));}
        catch(error){value=describeSemanticFailure(error);}
      }
      if(!event.error)event.result=structuredClone(value);
    }catch(error){event.error={category:error.semanticCode??'unexpected'};value=undefined;}
    events.push(event);step=plan.next(value);
  }
  const trace={boundary,events,docsCalls,logs,providerAfter:structuredClone(f.provider)};compareApplication(record,f,trace);return trace;
}
export function compareApplication(record,f,t){
  assert.deepEqual(t.boundary,applicationBoundary(record),'fixed application boundary, not native/persistence evidence');assert.equal(record.caseId,f.caseId);assert.equal(record.base,f.variant);assert.equal(record.outcomeVariant,f.outcome);assert.deepEqual(t.providerAfter,f.provider);
  let index=0,now=0,model,run,inspected=false,nextRead=2;const runs=new Map(),ids=new Set(),tokens=new Set(),cursors=new Map(),deliveries=new Map(),work=new Map();
  const view=f.view??'inline',missingReviewCoverage=f.expected.missingReviewCoverage??(view!=='inline'||Boolean(f.commentsDenied));
  function logicalState(){return{snapshots:inspected?[{id,subject:owner.subject,account:owner.account,thread:owner.threadId,created:0,expires:600000,evidence_digest:digest(JSON.stringify(f.provider.document))}]:[],cursors:[...cursors.values()],deliveries:[...deliveries.values()],pins:[],work:[...work].map(([id,bytes])=>({snapshot:'snap-d',id,bytes}))};}
  function selection(selected){const positions=f.expected.nodes.map(n=>n.id),ranges=[];for(const id of selected){const position=positions.indexOf(id);assert.ok(position>=0);const prior=ranges.at(-1);if(prior&&prior[0]+prior[1]===position)prior[1]++;else ranges.push([position,1]);}const ancestors=[];let parent=f.expected.nodes.find(n=>n.id===selected[0]).parent;while(parent&&!selected.includes(parent)){ancestors.push(parent);parent=f.expected.nodes.find(n=>n.id===parent).parent;}return{tabs:['tab-d'],runs:ranges,selectedFootprint:true,ancestors};}
  function start(a){const control=a.role==='control',extra=a.role==='opaqueControl',selected=extra?f.expected.extraIds:control?f.expected.controlIds:f.expected.selectedIds;return{projection:extra?f.expected.extraProjection:control?f.expected.controlProjection:f.expected.projection,selected,selection:selection(selected),request:extra?f.extraRead:control?f.controlRead:f.read,readId:`read-d-${nextRead++}`,offset:0,lossOffset:0};}
  function checkedModel(m){if(model){assert.deepEqual(m,model,'original model and unselected evidence preserved');return;}model=m;assertIndependentModel(m,f,record.ledgerId);assert.deepEqual(Object.values(m.nodes),f.expected.nodes,'independent complete typed model');assert.deepEqual(m.evidence,f.provider.document);assert.deepEqual(m.metadata,f.provider.metadata);assert.deepEqual(m.binding,{snapshotId:id,...owner,documentId:'doc-d',view:f.view??'inline',retrievedAt:0,responseDigest:digest(JSON.stringify(f.provider.document)),responseBytes:bytes(f.provider.document)});assert.equal(m.evidenceDigest,digest(JSON.stringify(f.provider.document)));for(const key of ['registryEntries','registryReferences','unknownFields'])if(f.expected[key])assert.deepEqual(m[key],f.expected[key],`independent ${key}`);assert.equal(m.materialized,'complete');assert.equal(m.missingReviewCoverage,f.expected.missingReviewCoverage??((f.view??'inline')!=='inline'||Boolean(f.commentsDenied)));}
  function fragments(q,result){if(!q.fragments)return;for(const [i,c]of result.candidates.entries()){const pieces=q.fragments[i];assert.deepEqual(c.runs,pieces.map(p=>p.node));assert.equal(pieces.map(p=>p.text).join(''),c.text);for(const p of pieces){const n=model.nodes[p.node];assert.equal(n.text.slice(p.start-n.extent.start,p.end-n.extent.start),p.text);}}}
  function page(a,r){
    if(a.args.cursor){assert.ok(runs.has(a.args.cursor),'actual continuation binding');runs.delete(a.args.cursor);cursors.delete(a.args.cursor);}
    const p=run.projection,all=new Set(p.records.map(x=>x.node??x.id)),orphans=p.losses.filter(l=>!all.has(l.node)),expected=p.records.slice(run.offset,run.offset+r.records.length),nodes=expected.map(x=>x.node??x.id),recordLosses=nodes.flatMap(n=>p.losses.filter(l=>l.node===n));
    assert.deepEqual(r.records,expected,'independent actual projection');const count=r.losses.length-recordLosses.length;assert.ok(count>=0);assert.deepEqual(r.losses,[...recordLosses,...orphans.slice(run.lossOffset,run.lossOffset+count)],'exact loss evidence');
    const end=run.offset+r.records.length,lossEnd=run.lossOffset+count,complete=end===p.records.length&&lossEnd===orphans.length;assert.ok(end<=p.records.length&&lossEnd<=orphans.length);assert.ok(!count||end===p.records.length);assert.ok(r.records.length||count||!p.records.length&&!orphans.length,'page makes progress');
    const aspects=['content','styles','review'].filter(v=>nodes.length&&nodes.every(n=>p.nodeAspects[n].includes(v))),nodeAspects=Object.fromEntries(nodes.map(n=>[n,p.nodeAspects[n]])),missingAspects=['content','styles','review'].filter(v=>!aspects.includes(v));
    const ancestors=run.selection.ancestors;
    assert.match(r.coverage.deliveryToken,/^[A-Za-z0-9_-]{1,128}$/);assert.ok(!tokens.has(r.coverage.deliveryToken));tokens.add(r.coverage.deliveryToken);
    assert.deepEqual(r,{snapshotId:id,view:f.view??'inline',revision:model.revision,records:expected,losses:r.losses,complete,nextCursor:r.nextCursor,selection:{ancestorsNotDelivered:ancestors,scope:'selectedFootprint'},coverage:{materialized:'complete',delivered:{nodes,aspects,nodeAspects},missingAspects,missingReviewCoverage:model.missingReviewCoverage,readProof:'scope_and_aspect_only',editReady:false,deliveryToken:r.coverage.deliveryToken},limitations:['API structure is not rendered fidelity','Read delivery is not authoring authorization'],thisCall:{providerMutationCount:0}},'complete application envelope');
    const delivery={snapshotId:id,evidenceDigest:model.evidenceDigest,view,readId:run.readId,scope:run.request.scope,selection:run.selection,format:run.request.format,offset:run.offset,lossOffset:run.lossOffset,nodes,aspects,nodeAspects,missingAspects,complete,losses:r.losses};
    assert.ok(bytes(r)<=f.pageBytes&&bytes(delivery)<=f.pageBytes);deliveries.set(r.coverage.deliveryToken,{id:r.coverage.deliveryToken,snapshot:id,data:delivery});run.offset=end;run.lossOffset=lossEnd;
    if(complete)assert.equal(r.nextCursor,null);else{assert.equal(typeof r.nextCursor,'string');assert.ok(!tokens.has(r.nextCursor));tokens.add(r.nextCursor);runs.set(r.nextCursor,run);const state={documentId:'doc-d',view,offset:end,lossOffset:lossEnd,selection:run.selection,request:{scope:run.request.scope,format:run.request.format,styles:run.request.styles??false,review:run.request.review??false,omitImages:run.request.omitImages??false,...run.request.registries?{registries:run.request.registries}:{}},readId:run.readId};assert.ok(bytes(state)<=f.pageBytes);cursors.set(r.nextCursor,{id:r.nextCursor,snapshot:id,expires:Math.min(now+300000,600000),state});}
  }
  const plan=programs[record.ledgerId](f);let step=plan.next();
  while(!step.done){const a=step.value,e=t.events[index++];assert.ok(e,'missing actual application invocation');assert.match(e.id,/^[a-f0-9-]{36}$/);assert.ok(!ids.has(e.id),'reused application invocation');ids.add(e.id);assert.deepEqual(e.instruction,a,'exact application instruction');assert.equal(e.clock,now);const r=e.result;
    if(a.op==='advance'){now=a.to;assert.equal(r,now);}
    else if(a.op==='get'){if(a.error)assert.deepEqual(e.error,{category:a.error});else{assert.equal(e.error,undefined);checkedModel(r);}}
    else if(a.op==='state'){assert.equal(e.error,undefined);assert.deepEqual(r,logicalState(),'exact logical publication/cursor/pin/work transition');}
    else if(a.op==='resolve'){if(a.q.error)assert.deepEqual(e.error,{category:a.q.error});else{assert.equal(e.error,undefined);assert.deepEqual(r,a.q.expected,'independent local selector answer');fragments(a.q,r);}}
    else if(a.op==='coverage'||a.op==='reviewCoverage'){assert.deepEqual(r,f.expected.authorityResult,'real core coverage decision');}
    else if(a.expect==='schema'){assert.deepEqual(e.error,{category:'schema'});assert.equal(r,undefined);}
    else if(['snapshot','scope','budget','scalar'].includes(a.expect)){assert.equal(e.error,undefined);assert.deepEqual(r,describeSemanticFailure({semanticCode:a.expect}),'exact application refusal');if(a.expect==='budget'&&a.name==='docs_read'){run=a.args.cursor?runs.get(a.args.cursor):start(a);assert.ok(run);work.set(run.readId,(work.get(run.readId)??0)+bytes(model)+bytes(run.projection));}}
    else if(a.expect==='inspect'){assert.equal(e.error,undefined);inspected=true;assert.deepEqual(r,expectedInspection(f),'independent complete inspection envelope');assert.ok(bytes(r)<=f.pageBytes);}
    else if(a.expect==='find'||a.expect==='selector'){assert.equal(e.error,undefined);const q=a.query??a.q;assert.deepEqual(r,a.expect==='find'?q.expected:{...q.expected,snapshotId:id,thisCall:{providerMutationCount:0}},'independent application find answer');fragments(q,r);assert.ok(bytes(r)<=65536);}
    else{assert.equal(a.expect,'page');assert.equal(e.error,undefined);run=a.args.cursor?runs.get(a.args.cursor):start(a);assert.ok(run);work.set(run.readId,(work.get(run.readId)??0)+bytes(model)+bytes(run.projection));page(a,r);}
    step=plan.next(a.expect==='schema'?null:r);
  }
  assert.equal(index,t.events.length,'orphan application invocation');assert.ok(!JSON.stringify(t.logs).includes('PRIVATE_'));assert.deepEqual(t.logs,f.commentsDenied?[{stage:'docs_inspect_review',category:'denied'}]:[]);
  // Protocol assertions belong to the real HTTP companion, not these calls.
  const inspectCount=t.events.filter(e=>e.instruction.expect==='inspect').length;assert.equal(inspectCount,1);
  const readCalls=t.docsCalls.filter(c=>c.operation==='read');assert.deepEqual(readCalls,f.commentsDenied?[{operation:'read',view:'inline',includeReview:true},{operation:'read',view:'inline',includeReview:false}]:[{operation:'read',view:f.view??'inline',includeReview:(f.view??'inline')==='inline'}]);
  return true;
}
