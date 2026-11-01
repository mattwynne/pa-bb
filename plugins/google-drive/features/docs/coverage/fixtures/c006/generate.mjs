// Independently authored finite C006 structural vectors. No production imports.
// Definitions, relationships, scope relations and typed property facts are
// explicit author input. This is not a general provider parser or projector.
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export const variants=['styles','objects','ranges','suggestions'],outcomes=['success','invalid','preservation','bounds','wrongSubject'];
const body={kind:'body'},scope={tabs:{ids:['tab-d']},segments:[body]},id=n=>`snap-d:${n}`;
const empty=()=>({explicit:{},properties:{},absent:'unknown'});
// Leaf paths/status and missing members are explicit expectations, not schema inference.
const prop=(key,value,leaves={[key]:value},missing=[],unknown=[])=>({key,value,leaves,missing,unknown});
const dimension=(key,value)=>prop(key,{magnitude:value,unit:'PT'},{[key+'.magnitude']:value,[key+'.unit']:'PT'});
function style(explicit=[],inherited=[],unknownParents=[]){
 const properties={},facts={},parents={};
 for(const p of inherited)parents[p.key]={value:p.value,provenance:'named',source:p.source};
 Object.assign(properties,parents);
 for(const p of explicit)properties[p.key]={value:p.value,provenance:p.unknown.length?'unknown':'direct'};
 for(const p of [...inherited,...explicit])facts[p.key]={atomic:true,leaves:Object.fromEntries(Object.entries(p.leaves).map(([path,stored])=>[path,{stored,status:p.unknown.includes(path)?'unknownSchema':'observed'}])),unknown:p.unknown,missing:p.missing,effectiveStatus:p.missing.length||p.unknown.length?'partialOrUnknown':'observed',inherited:parents[p.key]??null};
 return {explicit:Object.fromEntries(explicit.map(p=>[p.key,p.value])),properties,absent:'unknown',...Object.keys(facts).length?{propertyEvidence:facts}:{},...unknownParents.length?{unknownParentProperties:unknownParents}:{}};
}
const from=(source,...ps)=>ps.map(p=>({...p,source}));
function make(variant,outcome){
 const bounded=outcome==='bounds',commentsDenied=variant==='suggestions'&&(outcome==='preservation'||bounded),pageBytes=bounded?65536:6000;
 const document={documentId:'doc-d',title:'Independent C006',revisionId:'rev-c006',suggestionsViewMode:'SUGGESTIONS_INLINE',...commentsDenied?{}:{commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED'},tabs:[{tabProperties:{tabId:'tab-d',title:'Main',index:0},documentTab:{body:{content:[]}}}]};
 const tab=document.tabs[0].documentTab,path=['tabs',0,'documentTab'],nodes=[],defs=[],refs=[],diagnostics=[];let at=1;
 const rawAt=p=>p.reduce((v,k)=>v[k],document);
 function node(kind,parent,p,extra={},segment=body){const raw=rawAt(p),n={id:id(nodes.length+1),kind,parent,tabId:'tab-d',segment,extent:raw.endIndex===undefined?null:{start:raw.startIndex??0,end:raw.endIndex},evidence:{path:p,digest:hash(raw)},children:[],...extra};nodes.push(n);return n;}
 const root=node('segment',null,[...path,'body']);
 function paragraph(text,{ps,paragraphStyle=empty(),textStyle=empty(),directTextStyle,bullet,positioned,paragraphReview={},textReview={},extraParts=[]}={}){
  const start=at,els=[{startIndex:at,endIndex:at+text.length,textRun:{content:text,...directTextStyle?{textStyle:directTextStyle}:{},...textReview}}];at+=text.length;
  for(const part of extraParts){els.push({startIndex:at,endIndex:at+1,...part.raw});at++;}
  const raw={startIndex:start,endIndex:at,paragraph:{...ps?{paragraphStyle:ps}:{},...bullet?{bullet}:{},...positioned?{positionedObjectIds:positioned}:{},...paragraphReview,elements:els}},index=tab.body.content.length;tab.body.content.push(raw);
  const p=[...path,'body','content',index],parent=node('paragraph',root.id,p,{review:paragraphReview,extentStatus:'mapped',style:paragraphStyle,list:bullet??null,positionedObjectIds:positioned??[]});root.children.push(parent.id);
  const child=node('text',parent.id,[...p,'paragraph','elements',0],{review:textReview,extentStatus:'mapped',text,style:textStyle});parent.children.push(child.id);
  for(const [i,part]of extraParts.entries()){const n=node(part.kind,parent.id,[...p,'paragraph','elements',i+1],{review:{},extentStatus:'mapped',...part.expected});parent.children.push(n.id);}
  return {parent,children:parent.children.map(key=>nodes.find(n=>n.id===key)),ids:[parent.id,...parent.children]};
 }
 function def(tag,kind,category,providerId,p,{extra={},primary,control}={}){defs.push({tag,kind,category,providerId,path:p,extra,primary,control,tabId:p[0]==='tabs'?'tab-d':null});}
 function ref(owner,kind,category,providerId,field,targets=[],dependency){refs.push({owner,kind,category,providerId,field,targets,dependency});}
 let main,control,normalProps,normalParagraph,headingProps;
 if(variant==='styles'){
  normalProps=[prop('bold',false),dimension('fontSize',11)];normalParagraph=[dimension('spaceAbove',6)];
  const tone=bounded?'U'.repeat(66000):'retained unknown';headingProps=[prop('italic',true),prop('weightedFontFamily',{fontFamily:'Fiction'},{'weightedFontFamily.fontFamily':'Fiction'},['weightedFontFamily.weight']),prop('futureTone',tone,{'futureTone':tone},[],['futureTone'])];
  tab.namedStyles={styles:[{namedStyleType:'HEADING_1',textStyle:Object.fromEntries(headingProps.map(p=>[p.key,p.value])),paragraphStyle:{alignment:'CENTER'}},{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false,fontSize:{magnitude:11,unit:'PT'}},paragraphStyle:{spaceAbove:{magnitude:6,unit:'PT'}}}]};
  tab.lists={main:{listProperties:{nestingLevels:[{glyphFormat:'%0.',glyphType:'DECIMAL',startNumber:3}]}}};
  tab.documentStyle={documentFormat:{documentMode:'PAGELESS'},marginTop:{magnitude:72,unit:'PT'}};
  main=paragraph('A😀 é\n',{ps:{namedStyleType:'HEADING_1',alignment:'END'},paragraphStyle:style([prop('namedStyleType','HEADING_1'),prop('alignment','END')],[...from('NORMAL_TEXT',...normalParagraph),...from('HEADING_1',prop('alignment','CENTER'))]),directTextStyle:{bold:true},textStyle:style([prop('bold',true)],[...from('NORMAL_TEXT',...normalProps),...from('HEADING_1',...headingProps.slice(0,2))],[{source:'HEADING_1',field:'futureTone',digest:hash(tone)}]),bullet:{listId:'main',nestingLevel:0}});
  control=paragraph('CONTROL\n',{ps:{namedStyleType:'NORMAL_TEXT'},paragraphStyle:style([prop('namedStyleType','NORMAL_TEXT')],from('NORMAL_TEXT',...normalParagraph)),textStyle:style([],from('NORMAL_TEXT',...normalProps))});
  def('heading','namedStyle','styles','HEADING_1',[...path,'namedStyles','styles',0],{primary:'referenced',extra:{styles:{text:style(headingProps,from('NORMAL_TEXT',...normalProps)),paragraph:style([prop('alignment','CENTER')],from('NORMAL_TEXT',...normalParagraph))}}});
  def('normal','namedStyle','styles','NORMAL_TEXT',[...path,'namedStyles','styles',1],{primary:'referenced',control:'referenced',extra:{styles:{text:style(normalProps),paragraph:style(normalParagraph)}}});
  def('list','listDefinition','lists','main',[...path,'lists','main'],{primary:'referenced'});
  const properties={documentFormat:{stored:tab.documentStyle.documentFormat,provenance:'direct',propertyEvidence:{atomic:true,leaves:{'documentFormat.documentMode':{stored:'PAGELESS',status:'observed'}},unknown:[],missing:[],effectiveStatus:'observed'},effective:{status:'storedApiValue',value:tab.documentStyle.documentFormat}},marginTop:{stored:tab.documentStyle.marginTop,provenance:'direct',propertyEvidence:{atomic:true,leaves:{'marginTop.magnitude':{stored:72,status:'observed'},'marginTop.unit':{stored:'PT',status:'observed'}},unknown:[],missing:[],effectiveStatus:'observed'},effective:{status:'notApplicableInPageless'}}};
  def('page','documentStyle','styles',null,[...path,'documentStyle'],{primary:'tabStyle',control:'tabStyle',extra:{style:{stored:tab.documentStyle,properties,absent:'unknown',rendering:'notVerified'}}});
  ref(main.parent,'namedStyle','styles','HEADING_1','paragraphStyle.namedStyleType',['heading']);ref(main.parent,'namedStyle','styles','NORMAL_TEXT','inheritedNormalStyle',['normal']);ref(main.parent,'listDefinition','lists','main','bullet.listId',['list']);
  ref(main.children[0],'namedStyle','styles','HEADING_1','parentParagraph.namedStyleType',['heading'],main.parent);ref(main.children[0],'namedStyle','styles','NORMAL_TEXT','inheritedNormalStyle',['normal'],main.parent);
  ref(control.parent,'namedStyle','styles','NORMAL_TEXT','paragraphStyle.namedStyleType',['normal']);ref(control.children[0],'namedStyle','styles','NORMAL_TEXT','parentParagraph.namedStyleType',['normal'],control.parent);
 }else if(variant==='objects'){
  const image=title=>({inlineObjectProperties:{embeddedObject:{title,imageProperties:{contentUri:'https://assets.invalid/never-fetch.png'},futureObjectMetadata:{opaque:true}}}});
  tab.inlineObjects={main:image(bounded?'O'.repeat(66000):'Visible definition '+ 'o'.repeat(900)),control:image('Control'),unused:image('Unselected definition')};tab.positionedObjects={floating:{positionedObjectProperties:{embeddedObject:{title:'Retained positioned object',futureDrawing:{opaque:'d'.repeat(900)}}}}};
  const img=(name,kind)=>({kind:'inlineObjectElement',raw:{inlineObjectElement:{inlineObjectId:name}},expected:{properties:{inlineObjectId:name},style:empty(),opaqueType:'inlineObjectElement',objectKind:kind}});
  main=paragraph('A😀 é\n',{positioned:['floating','missing-positioned'],extraParts:[img('main','image'),img('missing-inline','unknown'),{kind:'opaqueInline',raw:{futureWidget:{label:'Uninterpreted',payload:'x'.repeat(2200)}},expected:{properties:null,opaqueType:'futureWidget'}}]});
  control=paragraph('CONTROL\n',{extraParts:[img('control','image')]});
  def('main-object','inlineObjectDefinition','objects','main',[...path,'inlineObjects','main'],{primary:'referenced'});def('control-object','inlineObjectDefinition','objects','control',[...path,'inlineObjects','control'],{control:'referenced'});def('unused-object','inlineObjectDefinition','objects','unused',[...path,'inlineObjects','unused']);def('positioned','positionedObjectDefinition','objects','floating',[...path,'positionedObjects','floating'],{primary:'referenced'});
  ref(main.parent,'positionedObjectDefinition','objects','floating','positionedObjectIds',['positioned']);ref(main.parent,'positionedObjectDefinition','objects','missing-positioned','positionedObjectIds');ref(main.children[1],'inlineObjectDefinition','objects','main','inlineObjectId',['main-object']);ref(main.children[2],'inlineObjectDefinition','objects','missing-inline','inlineObjectId');ref(control.children[1],'inlineObjectDefinition','objects','control','inlineObjectId',['control-object']);
  diagnostics.push({path:main.children[3].evidence.path,field:'futureWidget',primary:true});
 }else if(variant==='ranges'){
  main=paragraph('A😀 é\n');control=paragraph('CONTROL\n');
  const range=(namedRangeId,ranges)=>({name:'Shared',namedRangeId,ranges});
  tab.namedRanges={Shared:{name:'Shared',namedRanges:[range('range-a',bounded?Array.from({length:1600},()=>({tabId:'tab-d',startIndex:1,endIndex:4})):[{tabId:'tab-d',startIndex:1,endIndex:4},{tabId:'tab-d',startIndex:6,endIndex:8}]),range('range-b',[{tabId:'tab-d',startIndex:4,endIndex:6}]),range('range-control',[{tabId:'tab-d',startIndex:8,endIndex:16}]),range('range-header',[{tabId:'tab-d',segmentId:'head',startIndex:1,endIndex:3}]),range('range-incomplete',[{tabId:'tab-d',startIndex:2}]),range('range-reversed',[{tabId:'tab-d',startIndex:4,endIndex:1}]),range('range-other-tab',[{tabId:'other-tab',startIndex:1,endIndex:4}]),range('range-zero',[{tabId:'tab-d',startIndex:4,endIndex:4}]),...Array.from({length:5},(_,i)=>range(`range-page-${i}`,[{tabId:'tab-d',startIndex:1,endIndex:4}]))]}};
  const primary=['intersects','intersects',undefined,undefined,'unresolved','unresolved',undefined,'intersects',...Array(5).fill('intersects')],controls=[undefined,undefined,'intersects',undefined,'unresolved','unresolved',undefined,undefined];
  tab.namedRanges.Shared.namedRanges.forEach((r,i)=>def(r.namedRangeId,'namedRange','ranges',r.namedRangeId,[...path,'namedRanges','Shared','namedRanges',i],{primary:primary[i],control:controls[i],extra:{groupKey:'Shared',groupProperties:{name:'Shared'}}}));
 }else{
  const changes={suggestedParagraphStyleChanges:{'s-paragraph':{paragraphStyle:{alignment:'END'}}},suggestedBulletChanges:{'s-list':{bullet:{listId:'pending'}}},suggestedPositionedObjectIds:{'s-structure':{positionedObjectIds:['pending-object']}}};
  main=paragraph('A😀 é\n',{paragraphReview:changes,textReview:{suggestedInsertionIds:['s-insert'],suggestedDeletionIds:['s-delete','s-missing'],suggestedTextStyleChanges:{'s-text-style':{textStyle:{italic:true}}}}});control=paragraph('CONTROL\n',{textReview:{suggestedInsertionIds:['s-control']}});
  tab.suggestedDocumentStyleChanges={'s-doc':{documentStyle:{marginTop:{magnitude:36,unit:'PT'}}}};
  const comment={commentId:'c-one',anchorId:'anchor',content:'Comment with exact body anchor'};
  if(!commentsDenied){tab.commentAnchors={anchor:{anchorId:'anchor',ranges:[{tabId:'tab-d',startIndex:1,endIndex:4}]}};document.comments=[comment];main.parent.review={...main.parent.review,comments:[comment]};main.children[0].review={...main.children[0].review,comments:[comment]};def('anchor','commentAnchor','review','anchor',[...path,'commentAnchors','anchor'],{primary:'intersects'});}
  def('doc-change','suggestedDocumentStyle','review','s-doc',[...path,'suggestedDocumentStyleChanges','s-doc']);
  if(!commentsDenied)def('comment','commentThread','review','c-one',['comments',0],{primary:'intersects'});
  const descriptions=[['s-insert','insert'],['s-delete','delete'],['s-text-style','text-style'],['s-paragraph','paragraph-style'],['s-list','list'],['s-structure','structural'],['s-control','control'],['s-unanchored','unknown-scope']];
  document.suggestions=descriptions.map(([suggestionId,kind],i)=>({suggestionId,kind,description:bounded&&i===0?'S'.repeat(66000):kind+' '+ 's'.repeat(i===6?10:650)}));
  descriptions.forEach(([key],i)=>def(key,'suggestionThread','review',key,['suggestions',i],{primary:i===6?undefined:i===7?'unresolved':'referenced',control:i===6?'referenced':i===7?'unresolved':undefined}));
  for(const [field,key]of [['suggestedParagraphStyleChanges','s-paragraph'],['suggestedBulletChanges','s-list'],['suggestedPositionedObjectIds','s-structure']])ref(main.parent,'suggestionThread','review',key,field,[key]);
  if(!commentsDenied)ref(main.parent,'commentThread','review','c-one','comments',['comment']);
  for(const [field,key]of [['suggestedInsertionIds','s-insert'],['suggestedDeletionIds','s-delete'],['suggestedDeletionIds','s-missing'],['suggestedTextStyleChanges','s-text-style']])ref(main.children[0],'suggestionThread','review',key,field,key==='s-missing'?[]:[key]);
  if(!commentsDenied)ref(main.children[0],'commentThread','review','c-one','comments',['comment']);ref(control.children[0],'suggestionThread','review','s-control','suggestedInsertionIds',['s-control']);
 }
 const unselected=paragraph('KEEP\n');
 if(variant==='ranges'){
  tab.headers={head:{content:[{startIndex:1,endIndex:3,paragraph:{elements:[{startIndex:1,endIndex:3,textRun:{content:'H\n'}}]}}]}};
  const s={kind:'header',id:'head'},p=[...path,'headers','head'],h=node('segment',null,p,{},s),para=node('paragraph',h.id,[...p,'content',0],{review:{},extentStatus:'mapped',style:empty(),list:null,positionedObjectIds:[]},s),text=node('text',para.id,[...p,'content',0,'paragraph','elements',0],{review:{},extentStatus:'mapped',text:'H\n',style:empty()},s);h.children.push(para.id);para.children.push(text.id);
 }
 // Exact raw identity digests are authored from source values, never a model.
 for(const n of nodes)n.evidence.digest=hash(rawAt(n.evidence.path));
 const entries=defs.map((d,i)=>({id:`snap-d:registry:${i+1}`,kind:d.kind,category:d.category,tabId:d.tabId,providerId:d.providerId,evidence:{path:d.path,digest:hash(rawAt(d.path))},value:rawAt(d.path),diagnosticOnly:true,definitionStatus:'observed',...d.extra}));
 const index=Object.fromEntries(defs.map((d,i)=>[d.tag,entries[i].id]));
 const references=refs.map((r,i)=>({id:`snap-d:reference:${i+1}`,kind:'registryReference',category:r.category,ownerNode:r.owner.id,tabId:'tab-d',segment:r.owner.segment,providerId:r.providerId,definitionKind:r.kind,targets:r.targets.map(k=>index[k]),status:r.targets.length?'resolved':'unresolved',field:r.field,evidenceDigest:r.owner.evidence.digest,...r.dependency?{dependencyOwner:r.dependency.id,dependencyEvidenceDigest:r.dependency.evidence.digest}:{}}));
 function projection(role,ids){
  const records=[],losses=[],nodeAspects={};
  entries.forEach((entry,i)=>{const relation=defs[i][role];if(!relation)return;records.push({...entry,scopeRelation:relation,registryAspect:['styles','lists'].includes(entry.category)?'styles':entry.category==='review'?'review':'registry',provenance:{snapshotId:'snap-d',view:'inline'}});if(relation==='unresolved')losses.push({node:entry.id,kind:'unresolvedRegistryScope',missingAspects:['content','styles','review']});});
  for(const r of references)if(ids.includes(r.ownerNode)){records.push(r);if(r.status==='unresolved')losses.push({node:r.id,kind:'unresolvedReference',providerId:r.providerId,definitionKind:r.definitionKind});}
  for(const [i,d]of diagnostics.entries())if(d[role])records.push({id:`snap-d:unknown:${i}`,kind:'unknownField',tabId:'tab-d',field:d.field,path:d.path,digest:hash(rawAt([...d.path,d.field])),value:rawAt([...d.path,d.field]),diagnosticOnly:true,scopeRelation:'owner'});
  for(const r of records)nodeAspects[r.id]=['styles','lists'].includes(r.category)?['styles']:r.category==='review'&&!commentsDenied?['review']:[];
  return {records,losses,nodeAspects,aspects:[],missingAspects:['content','styles','review'],projection:'diagnostic'};
 }
 const registries={styles:['styles','lists'],objects:['objects','diagnostics'],ranges:['ranges'],suggestions:['review']}[variant],read={account:'reader@example.test',snapshotId:'snap-d',scope,selector:{node:main.parent.id},format:'structured',registries};
 return {provenance:{source:'c006/generate.mjs: authored structural definitions/relationships',authorship:'Independent inert expectations; no production oracle'},caseId:`C006.${variant}__read.${outcome}`,variant,outcome,pageBytes,provider:{identity:{sub:'subject-d',email:'reader@example.test',email_verified:true},otherIdentity:{sub:'subject-other',email:'other@example.test',email_verified:true},metadata:{id:'doc-d',name:'Independent C006',mimeType:'application/vnd.google-apps.document',version:'7',modifiedTime:'2026-01-01T00:00:00Z',trashed:false,capabilities:{canEdit:true}},document},commentsDenied,inspect:{account:'reader@example.test',document:'doc-d',scope},read,...bounded?{controlRead:{...read,selector:{node:control.parent.id}}}:{},expected:{nodes,registryEntries:entries,registryReferences:references,selectedIds:main.ids,unselectedIds:unselected.ids,projection:projection('primary',main.ids),...bounded?{controlIds:control.ids,controlProjection:projection('control',control.ids)}:{},snapshotExpires:600000,cursorExpires:300000}};
}
for(const variant of variants)for(const outcome of outcomes){const f=make(variant,outcome);writeFileSync(new URL(`${f.caseId}.json`,import.meta.url),JSON.stringify(f,null,2)+'\n');}
