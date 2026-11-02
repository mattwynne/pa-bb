// Original independent provider facts and literal public expectations. Node only:
// no production parser/model/service, captured output, SDK or provider access.
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root=new URL('../../../../',import.meta.url),dir=new URL('./',import.meta.url),hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const provenance={source:'s02-discovery/generate.mjs: original independently authored hierarchy, heading extents, metadata and capability facts',authorship:'Node-only declarative provider/expected facts; no production imports or captured semantic answers'};
const paragraph=(start,text,id,level)=>({startIndex:start,endIndex:start+text.length,paragraph:{...id?{paragraphStyle:{headingId:id,namedStyleType:`HEADING_${level}`}}:{},elements:[{startIndex:start,endIndex:start+text.length,textRun:{content:text}}]}});
const metadata={id:'doc-s02',name:'Original S02 inspection',mimeType:'application/vnd.google-apps.document',version:'17',modifiedTime:'2026-11-01T00:00:00Z',trashed:false,capabilities:{canEdit:true}};
function facts(many=false){
 const document={documentId:'doc-s02',revisionId:'docs-r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[]};
 let tabs,nodes;
 if(many){tabs=Array.from({length:100},(_,i)=>({id:`tab-${i}`,title:`Tab ${i} `+'X'.repeat(180),parent:null,ordinal:i,siblingIndex:i,depth:0,segment:`s02-a:${i*3+1}`,count:3}));document.tabs=tabs.map(t=>({tabProperties:{tabId:t.id,title:t.title,index:t.ordinal},documentTab:{body:{content:[paragraph(1,'x\n')]}}}));nodes=300;}
 else{document.tabs=[{tabProperties:{tabId:'tab-a',title:'Main',index:7},documentTab:{body:{content:[paragraph(1,'Plan\n','plan',1),paragraph(6,'Alpha\n'),paragraph(12,'Terms\n','terms',2),paragraph(18,'Beta\n'),paragraph(23,'Next\n','next',1),paragraph(28,'Omega\n')]}},childTabs:[{tabProperties:{tabId:'tab-child',title:'Details',index:9},documentTab:{body:{content:[paragraph(1,'Child\n')]}},childTabs:[{tabProperties:{tabId:'tab-leaf',title:'Leaf',index:0},documentTab:{body:{content:[paragraph(1,'Leaf\n')]}}}]}]},{tabProperties:{tabId:'tab-b',title:'Main',index:1},documentTab:{body:{content:[paragraph(1,'Sibling\n')]}}}];
 tabs=[{id:'tab-a',title:'Main',parent:null,ordinal:0,siblingIndex:7,depth:0,segment:'s02-a:1',count:13},{id:'tab-child',title:'Details',parent:'tab-a',ordinal:1,siblingIndex:9,depth:1,segment:'s02-a:14',count:3},{id:'tab-leaf',title:'Leaf',parent:'tab-child',ordinal:2,siblingIndex:0,depth:2,segment:'s02-a:17',count:3},{id:'tab-b',title:'Main',parent:null,ordinal:3,siblingIndex:1,depth:0,segment:'s02-a:20',count:3}];nodes=22;}
 return{document,tabs,nodes};
}
const scope={tabs:{ids:['tab-a']},segments:[{kind:'body'}]},account='reader@example.test';
const caps=m=>({read:{schema:'supported',account:'observed'},nativeSuggestions:{schema:'supported',account:'unverified'},authoring:{product:'not_exposed',account:'unverified'},documentPermission:m.capabilities?.canEdit===true?'editorObserved':m.capabilities?.canEdit===false?'notEditorObserved':'unverified'});
function outline(id='s02-a'){return[['plan',2,1,0,['Plan'],1,23,'nextHeading',10,'Plan'],['terms',6,2,1,['Plan','Terms'],12,23,'nextHeading',10,'Terms'],['next',10,1,0,['Next'],23,34,'segmentBoundary',12,'Next']].map(([providerId,node,level,depth,path,start,end,kind,boundary,title])=>({providerId,node:`${id}:${node}`,tabId:'tab-a',segment:{kind:'body'},level,title,extent:{start,end},link:`https://docs.google.com/document/d/doc-s02/edit?tab=tab-a#heading=${providerId}`,path,depth,sectionEnd:{kind,node:`${id}:${boundary}`}}));}
function expectation(s,id='s02-a',now=0){const m=s.metadata,d=s.document,capabilities=caps(m),kind=m.mimeType==='text/markdown'||m.mimeType==='text/x-markdown'?'markdownBlob':m.mimeType==='application/msword'||m.mimeType.endsWith('wordprocessingml.document')?'wordBlob':'nativeDoc';
 if(kind!=='nativeDoc')return{kind,metadata:m,capabilities,snapshotId:null,content:'codecNotImplemented',coverage:{materialized:'none',delivered:'metadata',readProof:false},thisCall:{providerMutationCount:0}};
 const selected=s.args.scope.tabs.all?s.tabs:s.args.scope.tabs.ids?s.tabs.filter(t=>s.args.scope.tabs.ids.includes(t.id)):s.tabs.filter(t=>t.id==='tab-child');
 return{kind,metadata:m,capabilities,snapshotId:id,view:'inline',revision:{kind:'docs',id:d.revisionId,subject:'subject-d'},tabs:selected.map(t=>({id:t.id,title:t.title,parent:t.parent,ordinal:t.ordinal,siblingIndex:t.siblingIndex,depth:t.depth,segments:[{node:t.segment.replace('s02-a',id),segment:{kind:'body'}}]})),outline:selected.some(t=>t.id==='tab-a')?outline(id).filter(h=>s.args.outlineDepth===undefined||h.depth<=s.args.outlineDepth):[],counts:{nodes:selected.reduce((n,t)=>n+t.count,0),unknownNodes:0},registries:selected.map(t=>({tabId:t.id,counts:Object.fromEntries(['lists','namedStyles','namedRanges','inlineObjects','positionedObjects','bookmarks','dropdownDefinitions','commentAnchors'].map(k=>[k,0])),readProof:false})),diagnosticRead:{include:['tabs','outline','styles','lists','objects','ranges','review','diagnostics'],paged:true},provenance:{provider:'googleDocs',retrievedAt:now,responseDigest:hash(d),source:'current',effectiveDefaults:'unknownWhenAbsent'},coverage:{materialized:'complete',delivered:'summary',readProof:false,missingReviewCoverage:false},thisCall:{providerMutationCount:0}};
}
function scenario(base,variant){const f=facts(),s={kind:'summary',metadata:structuredClone(metadata),...f,args:{account,document:'doc-s02',scope:structuredClone(scope)}};
 if(base==='C001'){if(variant==='markdownBlob')s.metadata.mimeType='text/markdown';if(variant==='wordBlob')s.metadata.mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document';if(variant==='permissionUnknown')delete s.metadata.capabilities;}
 if(base==='C002'){if(['all','duplicateTitle','recursive'].includes(variant))s.args.scope.tabs={all:true};if(variant==='selected')s.args.scope.tabs={ids:['tab-child']};}
 if(base==='C165'&&variant==='notReadProof')s.kind='proof';
 if(base==='C165'&&variant==='changeAwareness'){s.kind='change';s.nextMetadata={...s.metadata,version:'18',modifiedTime:'2026-11-02T00:00:00Z'};s.nextDocument={...s.document,revisionId:'docs-r2'};}
 s.expected=expectation(s);if(s.kind==='change'){const next={...s,metadata:s.nextMetadata,document:s.nextDocument};s.expectedNext=expectation(next,'s02-b',1);}
 return s;
}
function paged(s,variant){const f=facts(true);
 if(variant==='duplicateTitle'){for(const t of f.tabs)t.title='Duplicate '+'X'.repeat(180);for(const t of f.document.tabs)t.tabProperties.title='Duplicate '+'X'.repeat(180);}
 if(variant==='recursive'){for(let i=0;i<100;i+=3){const root=f.document.tabs[i],child=f.document.tabs[i+1],leaf=f.document.tabs[i+2];if(child){root.childTabs=[child];f.tabs[i+1].parent=f.tabs[i].id;f.tabs[i+1].depth=1;f.tabs[i+1].siblingIndex=i+1;}if(leaf){child.childTabs=[leaf];f.tabs[i+2].parent=f.tabs[i+1].id;f.tabs[i+2].depth=2;}}f.document.tabs=f.document.tabs.filter((_,i)=>i%3===0);}
 s={...s,kind:'paged',...f,args:{account,document:'doc-s02',scope:{tabs:variant==='selected'?{ids:f.tabs.map(t=>t.id)}:{all:true},segments:[{kind:'body'}]},include:['tabs']},pageBytes:3000};s.expectedCapabilities=caps(s.metadata);s.expectedProvenance={provider:'googleDocs',retrievedAt:0,responseDigest:hash(s.document),source:'current',effectiveDefaults:'unknownWhenAbsent'};
 s.expectedRecords=[{id:'s02-a:metadata',kind:'documentSummary',metadata:s.metadata,counts:{selectedNodes:300},capabilities:{authoring:'not_exposed',nativeSuggestions:'accountUnverified'},readProof:false},...s.tabs.flatMap(t=>[{id:`s02-a:tab:${t.ordinal}`,kind:'tabSummary',tabId:t.id,title:t.title,parent:t.parent,ordinal:t.ordinal,siblingIndex:t.siblingIndex,depth:t.depth},{id:`s02-a:segmentSummary:${t.segment}`,kind:'segmentSummary',ownerNode:t.segment,tabId:t.id,segment:{kind:'body'},selected:true}])];delete s.expected;delete s.expectedNext;delete s.nextMetadata;delete s.nextDocument;return s;}
const rows={C001:{operation:'docs_inspect.kind',featureId:'F_READ',scenarioId:'S_KIND',variants:['nativeDoc','markdownBlob','wordBlob','permissionUnknown','capabilityUnverified']},C002:{operation:'docs_inspect.tabs',featureId:'F_READ',scenarioId:'S_TABS',variants:['recursive','selected','all','duplicateTitle']},C165:{operation:'docs_inspect.provenance',featureId:'F_ADJACENT',scenarioId:'S_METADATA',variants:['changeAwareness','notReadProof']}};
const cases=[];mkdirSync(dir,{recursive:true});
for(const[id,row]of Object.entries(rows))for(const variant of row.variants)for(const outcome of ['success','invalid','preservation','bounds','wrongSubject']){
 const caseId=`${id}.${variant}__read.${outcome}`;if(caseId==='C001.nativeDoc__read.success')continue;
 const control=scenario(id,variant);let primary=structuredClone(control);
 if(outcome==='invalid'){primary.kind='error';primary.metadata={...primary.metadata,id:'wrong-document'};primary.error='conflict';}
 if(outcome==='wrongSubject'){if(['markdownBlob','wordBlob'].includes(variant)){primary.kind='error';primary.fault='authorityChanged';primary.error='snapshot';}else{primary=paged(primary,variant);primary.kind='pagedOwnership';}}
 if(outcome==='bounds'){
  if(['markdownBlob','wordBlob'].includes(variant)){primary.kind='error';primary.metadata.name='X'.repeat(65536);primary.error='budget';}
  else primary=paged(primary,variant);
 }
 if(variant==='markdownBlob'){control.metadata.mimeType='text/x-markdown';control.expected=expectation(control);}
 if(variant==='wordBlob'){control.metadata.mimeType='application/msword';control.expected=expectation(control);}
 if(variant==='permissionUnknown'){control.metadata.capabilities={canEdit:false};control.expected=expectation(control);}
 const checks=[];
 if(id==='C002'&&outcome==='invalid'){
  checks.push(structuredClone(primary));primary=scenario(id,variant);primary.kind='error';
  if(variant==='recursive'){primary.document.tabs[0].childTabs[0].tabProperties.parentTabId='tab-b';primary.error='conflict';}
  if(variant==='selected'){primary.args.scope.tabs={ids:['missing-tab']};primary.error='scope';}
  if(variant==='all'){primary.args.scope.segments=[{kind:'header',id:'missing-header'}];primary.error='scope';}
  if(variant==='duplicateTitle'){primary.kind='ambiguous';primary.args.scope.tabs={path:['Main']};primary.expected={kind:'nativeDoc',selection:{status:'ambiguous',candidates:[{tabId:'tab-a',title:'Main',parent:null},{tabId:'tab-b',title:'Main',parent:null}],nodes:[],roots:[]},snapshotId:null,thisCall:{providerMutationCount:0}};control.args.scope.tabs={ids:['tab-b']};control.expected=expectation(control);}
 }
 for(const s of [primary,control,...checks]){if(s.kind==='error')s.expectedFailure={outcome:'unavailable',category:s.error,guidance:'Check explicit scope and connected account; expired snapshots require a new inspection.',thisCall:{providerMutationCount:0}};if(s.kind==='pagedOwnership')s.expectedOwnerFailure={outcome:'unavailable',category:'snapshot',guidance:'Check explicit scope and connected account; expired snapshots require a new inspection.',thisCall:{providerMutationCount:0}};}
 const f={provenance,caseId,variant,outcome,primary,control,checks,preservation:outcome==='preservation'};
 writeFileSync(new URL(caseId+'.json',dir),JSON.stringify(f,null,2)+'\n');cases.push({caseId,...row,variant,outcome});
}
// This generator writes only original fixtures and a discovery feature. Registry,
// manifest delivery and acceptance membership remain explicit integration work.
const groups=Object.entries(rows).map(([id,row])=>`@${id} @${row.featureId} @${row.scenarioId}\n  Scenario Outline: Actual S02 inspection [<caseId>]\n    When the offline production bridge executes "<caseId>"\n    Examples:\n      | caseId |\n${row.variants.flatMap(v=>['success','invalid','preservation','bounds','wrongSubject'].map(o=>`      | ${id}.${v}__read.${o} |`)).join('\n')}`);
writeFileSync(new URL('../../../semantic-s02-discovery.feature',dir),'@docs @bridgeExecution\nFeature: Inspect kinds, recursive tabs and provenance through actual read use cases\n\n'+groups.join('\n\n')+'\n');
console.log(`Authored ${cases.length} original fixtures; original nativeDoc supplemental bytes left untouched.`);
