// Independently authored rich-cell vectors. Finite literal table/paragraph/run
// vocabulary, not a provider parser. No production model/projector/selector is
// imported or called; actual execution never supplies expected values.
import {writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const variants=['adjacentRuns','inlineObject','nestedTable','paragraphNewlines'],outcomes=['success','invalid','preservation','bounds','wrongSubject'];
const body={kind:'body'},scope={tabs:{ids:['tab-d']},segments:[body]},empty=()=>({explicit:{},properties:{},absent:'unknown'});
function direct(properties={}){const keys=Object.keys(properties);return keys.length?{explicit:properties,properties:Object.fromEntries(keys.map(k=>[k,{value:properties[k],provenance:'direct'}])),absent:'unknown',propertyEvidence:Object.fromEntries(keys.map(k=>{const v=properties[k],leaves=typeof v==='object'?Object.fromEntries(Object.entries(v).map(([key,value])=>[k+'.'+key,{stored:value,status:'observed'}])):{[k]:{stored:v,status:'observed'}};return [k,{atomic:true,leaves,unknown:[],missing:[],effectiveStatus:'observed',inherited:null}];}))}:empty();}
function make(variant,outcome){
 const bounded=outcome==='bounds',format=['adjacentRuns','paragraphNewlines'].includes(variant)?'text':'structured';
 const document={documentId:'doc-d',title:'Independent C007 rich cells',revisionId:'rev-c007',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-d',title:'Cells',index:0},documentTab:{body:{content:[]}}}]},tab=document.tabs[0].documentTab,nodes=[],raws=new Map();let at=1;
 function emit(kind,parent,path,raw,extra={}){const n={id:`snap-d:${nodes.length+1}`,kind,parent:parent?.id??null,tabId:'tab-d',segment:body,extent:raw.endIndex===undefined?null:{start:raw.startIndex,end:raw.endIndex},evidence:{path,digest:''},children:[],...extra};nodes.push(n);raws.set(n.id,raw);if(parent)parent.children.push(n.id);return n;}
 const root=emit('segment',null,['tabs',0,'documentTab','body'],tab.body);
 function para(parent,parts,properties={}){
  const list=raws.get(parent.id).content,raw={startIndex:at,endIndex:0,paragraph:{...Object.keys(properties).length?{paragraphStyle:properties}:{},elements:[]}},path=[...parent.evidence.path,'content',list.length];list.push(raw);
  const p=emit('paragraph',parent,path,raw,{review:{},extentStatus:'mapped',style:direct(properties),list:null,positionedObjectIds:[]});
  for(const part of parts){const start=at;at+=part.kind==='text'?part.text.length:1;const el={startIndex:start,endIndex:at,...part.kind==='text'?{textRun:{content:part.text,...part.style?{textStyle:part.style}:{}}}:part.kind==='image'?{inlineObjectElement:{inlineObjectId:'cell-image',...part.payload?{futurePayload:part.payload}:{},textStyle:{underline:false}}}:{futureWidget:{label:'Opaque cell payload',payload:part.payload}}};
   const n=emit(part.kind==='text'?'text':part.kind==='image'?'inlineObjectElement':'opaqueInline',p,[...path,'paragraph','elements',raw.paragraph.elements.length],el,{review:{},extentStatus:'mapped',...part.kind==='text'?{text:part.text,style:direct(part.style)}:part.kind==='image'?{properties:{inlineObjectId:'cell-image',...part.payload?{futurePayload:part.payload}:{}},style:direct({underline:false}),opaqueType:'inlineObjectElement',objectKind:'image'}:{properties:null,opaqueType:'futureWidget'}});raw.paragraph.elements.push(el);
  }
  raw.endIndex=at;p.extent={start:raw.startIndex,end:at};return p;
 }
 function table(parent,rows,style={}){
  const list=raws.get(parent.id).content,path=[...parent.evidence.path,'content',list.length],raw={startIndex:at++,endIndex:0,table:{rows:rows.length,columns:rows[0].length,tableRows:[],...Object.keys(style).length?{tableStyle:style}:{}}};list.push(raw);
  const t=emit('table',parent,path,raw,{review:{},extentStatus:'mapped',grid:[],style});
  rows.forEach((cells,r)=>{const rr={startIndex:at++,endIndex:0,tableCells:[]};raw.table.tableRows.push(rr);const row=emit('tableRow',t,[...path,'table','tableRows',r],rr,{style:{},review:{},extentStatus:'mapped'});t.grid.push([]);
   cells.forEach((build,c)=>{const cr={startIndex:at++,endIndex:0,tableCellStyle:{rowSpan:1,columnSpan:1},content:[]};rr.tableCells.push(cr);const cell=emit('tableCell',row,[...row.evidence.path,'tableCells',c],cr,{origin:{row:r,column:c},rowSpan:1,columnSpan:1,style:cr.tableCellStyle,review:{},extentStatus:'mapped'});t.grid[r].push(cell.id);build(cell);cr.endIndex=at++;cell.extent={start:cr.startIndex,end:cr.endIndex};});
   rr.endIndex=at++;row.extent={start:rr.startIndex,end:rr.endIndex};});
  raw.endIndex=at++;t.extent={start:raw.startIndex,end:raw.endIndex};return t;
 }
 const text=(value,style)=>({kind:'text',text:value,...style?{style}:{}}),byId=key=>nodes.find(n=>n.id===key),children=n=>n.children.map(byId),closure=n=>[n.id,...children(n).flatMap(closure)];
 let cell,neighbor,main,control,invalid,inner,object;
 table(root,[[c=>{
  cell=c;
  if(variant==='adjacentRuns'){
   const p=para(c,[text((bounded?'A'.repeat(65999):'A😀'+'a'.repeat(1396))+'e',{bold:true}),text('\u0301'+'b'.repeat(1399),{italic:true}),text('tail '+'c'.repeat(1394)+'\n',{fontSize:{magnitude:11,unit:'PT'}})],{alignment:'CENTER'}),runs=children(p);
   main=bounded?{node:runs[0]}:{node:c};if(bounded)control={from:runs[1],to:runs[2]};invalid={from:runs[2],to:runs[0]};
  }else if(variant==='paragraphNewlines'){
   const p1=para(c,[text(bounded?'F'.repeat(66000):'First😀'+'f'.repeat(1393),{bold:true}),text(' line'+'g'.repeat(1394)+'\n',{italic:true})],{alignment:'START'}),p2=para(c,[text('\n',{bold:false})]),p3=para(c,[text('Last e\u0301 '+'h'.repeat(1391)+'\n',{fontSize:{magnitude:10,unit:'PT'}})],{alignment:'END'});
   main=bounded?{node:children(p1)[0]}:{node:c};if(bounded)control={from:p2,to:p3};invalid={from:p3,to:p1};
  }else if(variant==='inlineObject'){
   tab.inlineObjects={'cell-image':{objectId:'cell-image',inlineObjectProperties:{embeddedObject:{title:'Cell illustration',imageProperties:{contentUri:'https://assets.invalid/cell-never-fetch.png'},futureImageData:{opaque:true}}}}};
   const p=para(c,[text('Before😀 '+'p'.repeat(1400),{bold:true}),{kind:'image',...bounded?{payload:'I'.repeat(66000)}:{}},{kind:'opaque',payload:'x'.repeat(1200)},text('After '+'q'.repeat(1400)+'\n',{italic:true})]);object=children(p)[1];
   main=bounded?{node:object}:{node:c};control={node:object,registries:['objects']};invalid={from:children(p)[3],to:children(p)[0]};
  }else{
   const before=para(c,[text('Before nested\n',{bold:true})]);let first;
   inner=table(c,[[x=>{first=x;para(x,[text('Inner A😀 '+'a'.repeat(400)+'\n',{bold:true})]);},x=>para(x,[text('Inner B\n',{italic:true})])],[x=>para(x,[text('Inner C e\u0301\n',{bold:false})]),x=>para(x,[text('Inner D\n',{fontSize:{magnitude:11,unit:'PT'}})])]],bounded?{futureLayoutMetadata:'N'.repeat(66000)}:{});
   const after=para(c,[text('After nested\n',{italic:true})]);main={node:bounded?inner:c};control={node:first};invalid={from:after,to:before};
  }
 },c=>{neighbor=c;para(c,[text('NEIGHBOR Ω\n',{bold:false})]);}]]);
 const outside=para(root,[text('OUTSIDE\n')]);
 for(const n of nodes)n.evidence.digest=hash(raws.get(n.id));
 const selected=s=>s.node?closure(s.node):children(byId(s.from.parent)).slice(children(byId(s.from.parent)).indexOf(s.from),children(byId(s.to.parent)).indexOf(s.to)+1).flatMap(closure);
 const selector=s=>s.node?{node:s.node.id}:{span:{from:s.from.id,to:s.to.id}},paths=s=>s.node?{node:s.node.evidence.path}:{span:{from:s.from.evidence.path,to:s.to.evidence.path}};
 const read={account:'reader@example.test',snapshotId:'snap-d',scope,selector:selector(main),format,styles:true};
 const registryEntries=object?[{id:'snap-d:registry:1',kind:'inlineObjectDefinition',category:'objects',tabId:'tab-d',providerId:'cell-image',evidence:{path:['tabs',0,'documentTab','inlineObjects','cell-image'],digest:hash(tab.inlineObjects['cell-image'])},value:tab.inlineObjects['cell-image'],diagnosticOnly:true,definitionStatus:'observed'}]:[];
 const registryReferences=object?[{id:'snap-d:reference:1',kind:'registryReference',category:'objects',ownerNode:object.id,tabId:'tab-d',segment:body,providerId:'cell-image',definitionKind:'inlineObjectDefinition',targets:['snap-d:registry:1'],status:'resolved',field:'inlineObjectId',evidenceDigest:object.evidence.digest}]:[];
 function projection(ids,{registries}={}){
  if(registries){const entry={...registryEntries[0],scopeRelation:'referenced',registryAspect:'registry',provenance:{snapshotId:'snap-d',view:'inline'}},records=[entry,...registryReferences];return {records,losses:[],nodeAspects:Object.fromEntries(records.map(r=>[r.id,[]])),aspects:[],missingAspects:['content','styles','review'],projection:'diagnostic'};}
  const records=[],losses=[],nodeAspects={};
  for(const key of ids){const n=byId(key);let record;
   if(format==='structured'){const {evidence,review,...value}=n;record={...value,...n.kind==='opaqueInline'?{providerEvidence:raws.get(n.id)}:{},evidenceDigest:evidence.digest};}
   else if(n.kind==='text')record={kind:'text',node:n.id,text:n.text,extent:n.extent,style:n.style};
   else if(!['segment','paragraph','tableRow','tableCell'].includes(n.kind))losses.push({node:n.id,kind:'nonText',sourceKind:n.kind});
   if(record){records.push(record);nodeAspects[n.id]=['content','styles'];}
  }
  return {records,losses,nodeAspects,aspects:['content','styles'],missingAspects:['review'],projection:format};
 }
 const selectedIds=selected(main),controlIds=control?selected(control):null;
 return {provenance:{source:'c007/generate.mjs: authored physical rich-cell vectors',authorship:'Independent literal topology, scalar/run/style and projection facts; no production oracle'},caseId:`C007.${variant}__read.${outcome}`,variant,outcome,pageBytes:bounded?65536:6000,provider:{identity:{sub:'subject-d',email:'reader@example.test',email_verified:true},otherIdentity:{sub:'subject-other',email:'other@example.test',email_verified:true},metadata:{id:'doc-d',name:'Independent C007 rich cells',mimeType:'application/vnd.google-apps.document',version:'7',modifiedTime:'2026-01-01T00:00:00Z',trashed:false,capabilities:{canEdit:true}},document},commentsDenied:false,inspect:{account:'reader@example.test',document:'doc-d',scope},read,cellPath:cell.evidence.path,mainPaths:paths(main),invalidPaths:paths(invalid),...control?{controlPaths:paths(control),controlRead:{...read,selector:selector(control),...control.registries?{format:'structured',registries:control.registries}:{}}}:{},expected:{nodes,registryEntries,registryReferences,selectedIds,unselectedIds:[...closure(neighbor),...closure(outside)],projection:projection(selectedIds),...control?{controlIds,controlProjection:projection(controlIds,control)}:{},snapshotExpires:600000,cursorExpires:300000}};
}
for(const variant of variants)for(const outcome of outcomes){const f=make(variant,outcome);writeFileSync(new URL(`${f.caseId}.json`,import.meta.url),JSON.stringify(f,null,2)+'\n');}
