import { randomUUID } from 'node:crypto';
import { LIMITS, requireValue, semanticError, jsonBytes } from './common.mjs';
import { materialize } from './model.mjs';
import { parseDocument, resolveScope, resolveSelector, findLiteral } from './selectors.mjs';
import { project, packReadProjection, resolveReadSelection, freezeReadSelection, thawReadSelection, projectInspection } from './reader.mjs';
const mimeKinds={'application/vnd.google-apps.document':'nativeDoc','text/markdown':'markdownBlob','text/x-markdown':'markdownBlob',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'wordBlob','application/msword':'wordBlob'};
export function createSemanticReadService({store,docs,clock=Date.now,ids=randomUUID,diagnose=()=>{},pageBytes=LIMITS.pageBytes}) {
  const snapshots=store.semanticSnapshots;
  async function owner(account,threadId,signal) {
    requireValue(typeof account==='string'&&account.length<=320&&typeof threadId==='string'&&threadId.length>0);
    signal?.throwIfAborted();const record=await store.byEmail(account);requireValue(record,'unavailable');
    await docs.authority(record);signal?.throwIfAborted();const current=await store.byEmail(account);requireValue(current?.subject===record.subject,'snapshot');
    return {record,subject:record.subject,account:account.toLowerCase(),threadId};
  }
  async function inspect(args,threadId,signal) {
    if(args.cursor)return continueInspection(args,threadId,signal);
    const identity=await owner(args.account,threadId,signal),{documentId,urlTab}=parseDocument(args.document);
    const metadata=await docs.metadata(identity.record,documentId,signal);requireValue(metadata.id===documentId&&!metadata.trashed,'conflict');
    const kind=Object.hasOwn(mimeKinds,metadata.mimeType)?mimeKinds[metadata.mimeType]:'other';
    const capabilities={read:{schema:'supported',account:'observed'},nativeSuggestions:{schema:'supported',account:'unverified'},
      authoring:{product:'not_exposed',account:'unverified'},documentPermission:metadata.capabilities?.canEdit===true?'editorObserved':metadata.capabilities?.canEdit===false?'notEditorObserved':'unverified'};
    if(kind!=='nativeDoc'){
      const result={kind,metadata,capabilities,snapshotId:null,content:'codecNotImplemented',coverage:{materialized:'none',delivered:'metadata',readProof:false},thisCall:{providerMutationCount:0}};
      jsonBytes(result,pageBytes);return result;
    }
    const view=args.view??'inline',read=await docs.read(identity.record,documentId,view,signal);
    if(read.commentsDenied)diagnose('docs_inspect_review',semanticError('denied'));
    const snapshot=materialize({document:read.document,metadata,binding:{snapshotId:ids(),subject:identity.subject,account:identity.account,threadId,documentId,view,retrievedAt:clock(),responseDigest:read.responseDigest,responseBytes:read.responseBytes},reviewIncluded:read.reviewIncluded});
    const selected=resolveScope(snapshot,args.scope,urlTab);
    if(selected.status!=='resolved')return {kind,selection:selected,snapshotId:null,thisCall:{providerMutationCount:0}};
    const selectedNodes=new Set(selected.nodes),tabs=snapshot.tabs.filter(t=>selected.tabs.includes(t.providerId));
    const result={kind,metadata,capabilities,snapshotId:snapshot.binding.snapshotId,view,revision:snapshot.revision,
      tabs:tabs.map(t=>({id:t.providerId,title:t.title,parent:t.parent,ordinal:t.ordinal,siblingIndex:t.siblingIndex,depth:t.depth,segments:t.segments.map(id=>({node:id,segment:snapshot.nodes[id].segment}))})),
      outline:snapshot.outline.filter(h=>selectedNodes.has(h.node)&&(args.outlineDepth===undefined||h.depth<=args.outlineDepth)),
      counts:{nodes:selected.nodes.length,unknownNodes:selected.nodes.filter(id=>snapshot.nodes[id].kind.startsWith('opaque')).length},
      registries:tabs.map(t=>({tabId:t.providerId,counts:Object.fromEntries(Object.entries(t.registries).map(([key,value])=>[key,
        key==='namedStyles'?value?.styles?.length??0:key==='namedRanges'?Object.values(value??{}).reduce((sum,group)=>sum+group.namedRanges.length,0):value?Object.keys(value).length:0])),readProof:false})),
      diagnosticRead:{include:['tabs','outline','styles','lists','objects','ranges','review','diagnostics'],paged:true},
      provenance:{provider:'googleDocs',retrievedAt:snapshot.binding.retrievedAt,responseDigest:read.responseDigest,source:'current',effectiveDefaults:'unknownWhenAbsent'},
      coverage:{materialized:'complete',delivered:'summary',readProof:false,missingReviewCoverage:snapshot.missingReviewCoverage},thisCall:{providerMutationCount:0}};
    // Preserve the small summary interface, but every growing list also has a
    // paged route. Overflow selects that route; never truncate a summary while
    // reporting it complete. Explicit include always requests typed pages.
    let small=false;
    try{small=jsonBytes(result,pageBytes)<=pageBytes;}catch(error){if(error.semanticCode!=='budget')throw error;}
    signal?.throwIfAborted();
    if(!args.include&&small){snapshots.put(snapshot,clock());return result;}
    const state={documentId,view,offset:0,lossOffset:0,readId:ids(),selection:freezeReadSelection(snapshot,selected),
      request:{operation:'inspect',scope:args.scope,include:args.include??['tabs','outline','styles','lists','objects','ranges','review','diagnostics'],outlineDepth:args.outlineDepth}};
    snapshots.put(snapshot,clock());
    const packed=inspectionPage(snapshot,state,identity);
    snapshots.commitPage(snapshot.binding.snapshotId,identity,packed.delivery,packed.nextState,clock(),packed.tokens);
    return packed.result;
  }
  async function read(args,threadId,signal) {
    const identity=await owner(args.account,threadId,signal);let snapshot,state;
    if(args.cursor){const continued=snapshots.peekCursor(args.cursor,identity,clock(),args.snapshotId);snapshot=continued.snapshot;state=continued.state;}
    else {
      snapshot=snapshots.get(args.snapshotId,identity,clock());
      const selected=resolveReadSelection(snapshot,args.scope,args.selector);
      if(selected.status!=='resolved'){
        const result={snapshotId:args.snapshotId,selection:selected,complete:false,readProof:false,thisCall:{providerMutationCount:0}};
        jsonBytes(result,pageBytes);return result;
      }
      state={documentId:snapshot.binding.documentId,view:snapshot.binding.view,offset:0,lossOffset:0,
        selection:freezeReadSelection(snapshot,selected),request:{scope:args.scope,format:args.format,styles:args.styles??false,review:args.review??false,omitImages:args.omitImages??false,...args.registries?{registries:args.registries}:{}},readId:ids()};
    }
    requireValue(snapshot.binding.snapshotId===args.snapshotId&&state.request.operation!=='inspect','snapshot');
    const selected=state.selection?thawReadSelection(snapshot,state.selection):resolveScope(snapshot,state.request.scope);requireValue(selected.status==='resolved','scope');
    const projection=project(snapshot,selected,state.request);
    // Projection is recomputed from immutable evidence, not a second paging
    // engine. Charge cumulative traversal/packing work across this read before
    // packing, with a durable bound that survives restart and cursor changes.
    snapshots.chargeReadWork(args.snapshotId,identity,state.readId,
      jsonBytes(snapshot,LIMITS.modelBytes)+jsonBytes(projection,LIMITS.modelBytes),clock());
    const tokens=snapshots.pageTokens(); // Actual bounded values, generated before sizing; no write.
    const packed=packReadProjection(projection,state,pageBytes,page=>{
      const {records,losses,nodes,nodeAspects,aspects,complete,nextOffset,nextLossOffset}=page;
      const missingAspects=['content','styles','review'].filter(aspect=>!aspects.includes(aspect));
      const delivery={snapshotId:args.snapshotId,evidenceDigest:snapshot.evidenceDigest,view:snapshot.binding.view,readId:state.readId,
        scope:state.request.scope,...(state.selection?.selectedFootprint?{selection:state.selection}:{}),format:state.request.format,offset:state.offset,lossOffset:state.lossOffset??0,
        nodes,aspects,nodeAspects,missingAspects,complete,losses};
      const result={snapshotId:args.snapshotId,view:snapshot.binding.view,revision:snapshot.revision,records,losses,complete,
        nextCursor:complete?null:tokens.nextCursor,
        ...(state.selection?.selectedFootprint?{selection:{ancestorsNotDelivered:state.selection.ancestors,scope:'selectedFootprint'}}:{}),
        coverage:{materialized:'complete',delivered:{nodes,aspects,nodeAspects},missingAspects,
          missingReviewCoverage:snapshot.missingReviewCoverage,readProof:'scope_and_aspect_only',editReady:false,deliveryToken:tokens.deliveryToken},
        limitations:['API structure is not rendered fidelity','Read delivery is not authoring authorization'],thisCall:{providerMutationCount:0}};
      return {result,delivery,nextState:complete?null:{...state,offset:nextOffset,lossOffset:nextLossOffset}};
    });
    signal?.throwIfAborted();
    snapshots.commitPage(args.snapshotId,identity,packed.delivery,packed.nextState,clock(),tokens,
      args.cursor?{cursor:args.cursor,state}:undefined);
    // No envelope mutation or size rejection after committing delivery evidence.
    return packed.result;
  }
  function inspectionPage(snapshot,state,identity) {
    const selected=thawReadSelection(snapshot,state.selection);
    const projection=projectInspection(snapshot,selected,state.request.include,state.request.outlineDepth);
    // Both initial and continuation pages charge once before fallible packing.
    // Keep this durable charge outside atomic cursor consumption/publication.
    snapshots.chargeReadWork(snapshot.binding.snapshotId,identity,state.readId,
      jsonBytes(snapshot,LIMITS.modelBytes)+jsonBytes(projection,LIMITS.modelBytes),clock());
    const tokens=snapshots.pageTokens();
    const packed=packReadProjection(projection,state,pageBytes,page=>{
      const {records,losses,nodes,nodeAspects,aspects,complete,nextOffset,nextLossOffset}=page;
      const delivery={snapshotId:snapshot.binding.snapshotId,evidenceDigest:snapshot.evidenceDigest,view:snapshot.binding.view,readId:state.readId,
        scope:state.request.scope,format:'diagnostic',offset:state.offset,lossOffset:state.lossOffset,nodes,nodeAspects,aspects,complete,losses};
      const result={kind:'nativeDoc',snapshotId:snapshot.binding.snapshotId,view:snapshot.binding.view,revision:snapshot.revision,
        records,losses,complete,nextCursor:complete?null:tokens.nextCursor,
        coverage:{materialized:'complete',delivered:{nodes,aspects,nodeAspects},readProof:false,editReady:false,missingReviewCoverage:snapshot.missingReviewCoverage,deliveryToken:tokens.deliveryToken},
        provenance:{provider:'googleDocs',source:'current',retrievedAt:snapshot.binding.retrievedAt,responseDigest:snapshot.binding.responseDigest},
        thisCall:{providerMutationCount:0}};
      return {result,delivery,nextState:complete?null:{...state,offset:nextOffset,lossOffset:nextLossOffset}};
    });
    return {...packed,tokens};
  }
  async function continueInspection(args,threadId,signal) {
    const identity=await owner(args.account,threadId,signal);
    const {snapshot,state}=snapshots.peekCursor(args.cursor,identity,clock(),args.snapshotId);
    requireValue(state.request.operation==='inspect','snapshot');
    const packed=inspectionPage(snapshot,state,identity);signal?.throwIfAborted();
    snapshots.commitPage(args.snapshotId,identity,packed.delivery,packed.nextState,clock(),packed.tokens,{cursor:args.cursor,state});
    return packed.result;
  }
  async function find(args,threadId,signal) {
    const identity=await owner(args.account,threadId,signal),snapshot=snapshots.get(args.snapshotId,identity,clock());
    const result=args.query?findLiteral(snapshot,args.scope,args.query):resolveSelector(snapshot,args.scope,args.selector);
    const output={...result,snapshotId:args.snapshotId,readProof:false,thisCall:{providerMutationCount:0}};
    requireValue(Buffer.byteLength(JSON.stringify(output))<=LIMITS.pageBytes,'budget');return output;
  }
  return {inspect,read,find};
}
