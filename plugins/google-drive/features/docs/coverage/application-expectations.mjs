// Independent assertions over authored fixture facts, not production helpers or
// returned model fields used to manufacture their own expected values.
import assert from 'node:assert/strict';
import { digest } from './audit.mjs';
const owner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'};
export function assertIndependentModel(model,f,ledgerId){
  assert.equal(model.version,1);assert.deepEqual(model.revision,{kind:'docs',id:f.provider.document.revisionId,subject:owner.subject},'independent exact original revision');
  assert.equal(model.currentEditEvidence,(f.view??'inline')==='inline');
  if(['C003','C010','C011','C012','C013','C015'].includes(ledgerId))assert.equal(model.unresolvedExtents,false,'independent resolved extent fact');
  if(ledgerId==='C008')assert.equal(model.unresolvedExtents,true,'independent retained unresolved extent fact');
  if(f.expected.tabs){assert.equal(model.tabs.length,f.expected.tabs.length);assert.deepEqual(model.tabs.map((t,i)=>Object.fromEntries(Object.keys(f.expected.tabs[i]).map(k=>[k,t[k]]))),f.expected.tabs,'independent authored tab inventory');}
  // Existing E fixtures contain no heading IDs; this is an authored fixture
  // property, not a promise about future documents or a computed model default.
  assert.equal(JSON.stringify(f.provider.document).includes('headingId'),false);
  assert.deepEqual(model.outline,[],'independent empty outline');
}
export function expectedInspection(f){
  const document=f.provider.document,view=f.view??'inline',scope=f.inspect.scope,flat=[];
  const visit=(tabs,parent=null,depth=0)=>{for(const raw of tabs){const p=raw.tabProperties;flat.push({raw,id:p.tabId,parent,depth,ordinal:flat.length});visit(raw.childTabs??[],p.tabId,depth+1);}};visit(document.tabs);
  const selectedTabs=scope.tabs.ids??flat.map(t=>t.id),tabs=flat.filter(t=>selectedTabs.includes(t.id));
  const nodes=f.expected.nodes.filter(n=>selectedTabs.includes(n.tabId)&&scope.segments.some(s=>s.kind===n.segment.kind&&(!s.id||s.id===n.segment.id)));
  const missingReviewCoverage=f.expected.missingReviewCoverage??(view!=='inline'||Boolean(f.commentsDenied));
  return {kind:'nativeDoc',metadata:f.provider.metadata,capabilities:{read:{schema:'supported',account:'observed'},nativeSuggestions:{schema:'supported',account:'unverified'},authoring:{product:'not_exposed',account:'unverified'},documentPermission:f.provider.metadata.capabilities?.canEdit===true?'editorObserved':f.provider.metadata.capabilities?.canEdit===false?'notEditorObserved':'unverified'},snapshotId:'snap-d',view,revision:{kind:'docs',id:document.revisionId,subject:owner.subject},
    tabs:tabs.map(t=>({id:t.id,title:t.raw.tabProperties.title,parent:t.parent,ordinal:t.ordinal,depth:t.depth,siblingIndex:t.raw.tabProperties.index??(t.parent?flat.filter(x=>x.parent===t.parent):flat.filter(x=>x.parent===null)).findIndex(x=>x.id===t.id),segments:f.expected.nodes.filter(n=>n.kind==='segment'&&n.tabId===t.id).map(n=>({node:n.id,segment:n.segment}))})),
    outline:[],counts:{nodes:nodes.length,unknownNodes:nodes.filter(n=>n.kind.startsWith('opaque')).length},
    registries:tabs.map(t=>({tabId:t.id,counts:Object.fromEntries(['lists','namedStyles','namedRanges','inlineObjects','positionedObjects','bookmarks','dropdownDefinitions','commentAnchors'].map(key=>{const value=t.raw.documentTab[key];return[key,key==='namedStyles'?value?.styles?.length??0:key==='namedRanges'?Object.values(value??{}).reduce((sum,group)=>sum+group.namedRanges.length,0):value?Object.keys(value).length:0];})),readProof:false})),
    diagnosticRead:{include:['tabs','outline','styles','lists','objects','ranges','review','diagnostics'],paged:true},
    provenance:{provider:'googleDocs',retrievedAt:0,responseDigest:digest(JSON.stringify(document)),source:'current',effectiveDefaults:'unknownWhenAbsent'},coverage:{materialized:'complete',delivered:'summary',readProof:false,missingReviewCoverage},thisCall:{providerMutationCount:0}};
}
