// Original inert C005 vectors. No production model/projector/selector imports.
// This deliberately small authoring vocabulary is NOT a provider parser. Every
// semantic identity, selected footprint, style fact and omission is specified
// here before execution; observed output is never used to generate expectations.
import {writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const variants=['text','structured','styleAnnotations','reviewAnnotations','omitImages','continuation'];
export const outcomes=['success','invalid','preservation','bounds','wrongSubject'];
const empty=()=>({explicit:{},properties:{},absent:'unknown'}),id=n=>`snap-d:${n}`,body={kind:'body'};
const scope={tabs:{ids:['tab-d']},segments:[body]};
function observed(value,path){return {[path]:{stored:value,status:'observed'}};}
function fact(leaves,inherited=null,missing=[]){return {atomic:true,leaves,unknown:[],missing,effectiveStatus:missing.length?'partialOrUnknown':'observed',inherited};}
function direct(properties){return {explicit:properties,properties:Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,{value:v,provenance:'direct'}])),absent:'unknown',propertyEvidence:Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,fact(typeof v==='object'?Object.fromEntries(Object.entries(v).map(([a,b])=>[`${k}.${a}`,{stored:b,status:'observed'}])):observed(v,k),null,k==='weightedFontFamily'?['weightedFontFamily.weight']:[])]))};}
function styleVector(){
 const inheritedBold={value:false,provenance:'named',source:'NORMAL_TEXT'},inheritedSize={value:{magnitude:11,unit:'PT'},provenance:'named',source:'NORMAL_TEXT'};
 return {explicit:{bold:true,weightedFontFamily:{fontFamily:'Fiction'}},properties:{bold:{value:true,provenance:'direct'},fontSize:inheritedSize,weightedFontFamily:{value:{fontFamily:'Fiction'},provenance:'direct'}},absent:'unknown',propertyEvidence:{bold:fact(observed(true,'bold'),inheritedBold),fontSize:fact({...observed(11,'fontSize.magnitude'),...observed('PT','fontSize.unit')},inheritedSize),weightedFontFamily:fact(observed('Fiction','weightedFontFamily.fontFamily'),null,['weightedFontFamily.weight'])},unknownParentProperties:[{source:'NORMAL_TEXT',field:'futureTone',digest:createHash('sha256').update('retained').digest('hex')}]};
}
function make(variant,outcome){
 const bounded=outcome==='bounds',continuation=variant==='continuation',omission=variant==='omitImages',structured=variant==='structured',styled=variant==='styleAnnotations',reviewed=variant==='reviewAnnotations';
 const pageBytes=continuation||bounded&&omission?3000:65536;
 const document={documentId:'doc-d',title:'Independent C005',revisionId:'rev-c005',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-d',title:'Main',index:0},documentTab:{body:{content:[]}}}]};
 const tab=document.tabs[0].documentTab,content=tab.body.content,nodes=[],paths={};let next=1,at=1;
 function node(kind,parent,start,end,extra,path,raw){const n={id:id(next++),kind,parent,tabId:'tab-d',segment:body,extent:start===null?null:{start,end},evidence:{path,digest:hash(raw)},children:[],...extra};nodes.push(n);paths[n.id]=path;return n;}
 const root=node('segment',null,null,null,{},['tabs',0,'documentTab','body'],tab.body);
 function paragraph(parts,{paragraphStyle,paragraphEvidence,review={},nodeReviews=[]}={}){
  const start=at,els=parts.map(part=>{const len=part.kind==='text'?part.text.length:1,el={startIndex:at,endIndex:at+len};at+=len;if(part.kind==='text')el.textRun={content:part.text,...part.directStyle?{textStyle:part.directStyle}:{},...part.review};else if(part.kind==='image')el.inlineObjectElement={inlineObjectId:'img'};else el.futureWidget={label:'not text',payload:part.payload??'opaque'};return el;});
  const raw={startIndex:start,endIndex:at,paragraph:{elements:els,...paragraphStyle?{paragraphStyle}:{}}},pi=content.length;content.push(raw);const path=['tabs',0,'documentTab','body','content',pi];
  const p=node('paragraph',root.id,start,at,{review,extentStatus:'mapped',style:paragraphEvidence??empty(),list:null,positionedObjectIds:[]},path,raw);root.children.push(p.id);
  parts.forEach((part,i)=>{const el=els[i],n=node(part.kind==='text'?'text':part.kind==='image'?'inlineObjectElement':'opaqueInline',p.id,el.startIndex,el.endIndex,{review:nodeReviews[i]??part.review??{},extentStatus:'mapped',...(part.kind==='text'?{text:part.text,style:part.expectedStyle??empty()}:part.kind==='image'?{properties:{inlineObjectId:'img'},style:empty(),opaqueType:'inlineObjectElement',objectKind:'image'}:{properties:null,opaqueType:'futureWidget'})},[...path,'paragraph','elements',i],el);p.children.push(n.id);});return p;
 }
 let selected,control;
 if(styled&&!bounded){
  tab.namedStyles={styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false,fontSize:{magnitude:11,unit:'PT'},futureTone:'retained'}}]};
  selected=paragraph([{kind:'text',text:'Styled😀\n',directStyle:{bold:true,weightedFontFamily:{fontFamily:'Fiction'}},expectedStyle:styleVector()}],{paragraphStyle:{namedStyleType:'NORMAL_TEXT'},paragraphEvidence:direct({namedStyleType:'NORMAL_TEXT'})});
 }else if(reviewed&&!bounded){
  const missing=outcome==='preservation',comment={commentId:'c-one',anchorId:'anchor',content:'Inspect these scalars'};
  document.suggestions=[{suggestionId:'s-insert',description:'Insertion evidence'},{suggestionId:'s-delete',description:'Deletion evidence'}];
  if(!missing){tab.commentAnchors={anchor:{anchorId:'anchor',ranges:[{tabId:'tab-d',startIndex:1,endIndex:4}]}};document.comments=[comment];}else delete document.commentsViewMode;
  selected=paragraph([{kind:'text',text:'A😀',review:{suggestedInsertionIds:['s-insert']}},{kind:'text',text:' é\n',review:{suggestedDeletionIds:['s-delete']}}],{review:missing?{}:{comments:[comment]},nodeReviews:[{suggestedInsertionIds:['s-insert'],...missing?{}:{comments:[comment]}},{suggestedDeletionIds:['s-delete']}]});
 }else if(continuation){selected=paragraph([{kind:'text',text:'A'.repeat(1398)+'😀'},{kind:'text',text:(bounded?'B'.repeat(4999):'B'.repeat(1399))+'\n'}]);}
 else if(omission){tab.inlineObjects={img:{inlineObjectProperties:{embeddedObject:{imageProperties:{contentUri:'https://assets.invalid/never-fetch.png'}}}}};selected=paragraph([{kind:'text',text:'Visible\n'},...Array.from({length:bounded?80:1},()=>({kind:'image'})),{kind:'text',text:'End\n'}]);if(bounded)control=selected.children[0];}
 else if(bounded){
  control=paragraph([{kind:'text',text:'Valid😀\n',...styled?{directStyle:{bold:true},expectedStyle:direct({bold:true})}:{},...reviewed?{review:{suggestedInsertionIds:['s-control']}}:{}}]).id;
  if(structured){paragraph([{kind:'opaque',payload:'X'.repeat(66000)}]);selected=nodes.at(-1);}
  else if(styled)selected=paragraph([{kind:'text',text:'Link\n',directStyle:{link:{url:'https://example.test/'+ 'L'.repeat(24000)}},expectedStyle:direct({link:{url:'https://example.test/'+ 'L'.repeat(24000)}})}]);
  else if(reviewed){const start=at,comment={commentId:'c-large',anchorId:'large',content:'C'.repeat(66000)};document.suggestions=[{suggestionId:'s-control',description:'Control insertion'}];document.comments=[comment];tab.commentAnchors={large:{anchorId:'large',ranges:[{tabId:'tab-d',startIndex:start,endIndex:start+6}]}};selected=paragraph([{kind:'text',text:'Large\n'}],{review:{comments:[comment]},nodeReviews:[{comments:[comment]}]});}
  else selected=paragraph([{kind:'text',text:'T'.repeat(65999)+'\n'}]);
 }else if(structured)selected=paragraph([{kind:'text',text:'Hi😀'},{kind:'opaque'},{kind:'text',text:'!\n'}]);
 else selected=paragraph([{kind:'text',text:'A😀'},{kind:'text',text:' é\n'}]);
 const unselected=paragraph([{kind:'text',text:'KEEP\n'}]);root.evidence.digest=hash(tab.body);
 const selectedIds=[selected.id,...selected.children],byId=Object.fromEntries(nodes.map(n=>[n.id,n])),read={account:'reader@example.test',snapshotId:'snap-d',scope,selector:{node:selected.id},format:structured?'structured':'text',...styled?{styles:true}:{},...reviewed?{review:true}:{},...omission?{omitImages:true}:{}};
 // Authored projection expectations over these explicit vectors. No engine is
 // called, and the supported record classes below are deliberately enumerated.
 function expectation(ids){
  const records=[],losses=[],nodeAspects={},requested=['content',...styled?['styles']:[],...reviewed&&document.commentsViewMode?['review']:[]];
  for(const key of ids){const n=byId[key];if(omission&&n.kind==='inlineObjectElement'){losses.push({node:key,kind:'omittedImage'});continue;}
   let record;
   if(structured){const {evidence,style,review,...data}=n;record={...data,...styled?{style}:{},...reviewed?{review}:{},...n.kind==='opaqueInline'?{providerEvidence:paths[key].reduce((v,k)=>v[k],document)}:{},evidenceDigest:evidence.digest};}
   else if(n.kind==='text')record={kind:'text',node:key,text:n.text,extent:n.extent,...styled?{style:n.style}:{},...reviewed?{review:n.review}:{}};
   if(record){records.push(record);nodeAspects[key]=requested.filter(a=>a!=='styles'||!n.style?.unknownParentProperties);}
   if(n.style?.unknownParentProperties)losses.push({node:key,kind:'unresolvedStyleInheritance',missingAspects:['styles'],unknownProperties:n.style.unknownParentProperties});
   if(!styled&&n.style)losses.push({node:key,kind:'styleAnnotationOmitted'});
   if(!reviewed&&n.review&&Object.keys(n.review).length)losses.push({node:key,kind:'reviewAnnotationOmitted'});
  }
  const aspects=requested.filter(a=>records.length&&Object.values(nodeAspects).every(xs=>xs.includes(a)));
  return {records,losses,nodeAspects,aspects,missingAspects:['content','styles','review'].filter(a=>!aspects.includes(a)),projection:read.format};
 }
 const controlIds=control?(byId[control].kind==='paragraph'?[control,...byId[control].children]:[control]):null;
 return {provenance:{source:'c005/generate.mjs: original explicit provider/semantic vectors',authorship:'Independent inert C005 expectations; no production oracle'},caseId:`C005.${variant}__read.${outcome}`,variant,outcome,pageBytes,provider:{identity:{sub:'subject-d',email:'reader@example.test',email_verified:true},otherIdentity:{sub:'subject-other',email:'other@example.test',email_verified:true},metadata:{id:'doc-d',name:'Independent C005',mimeType:'application/vnd.google-apps.document',version:'7',modifiedTime:'2026-01-01T00:00:00Z',trashed:false,capabilities:{canEdit:true}},document},commentsDenied:reviewed&&outcome==='preservation',inspect:{account:'reader@example.test',document:'doc-d',scope},read,...control?{controlRead:{...read,selector:{node:control}}}:{},expected:{nodes,selectedIds,unselectedIds:[unselected.id,...unselected.children],projection:expectation(selectedIds),...controlIds?{controlIds,controlProjection:expectation(controlIds)}:{},snapshotExpires:600000,cursorExpires:300000}};
}
for(const variant of variants)for(const outcome of outcomes){const f=make(variant,outcome);writeFileSync(new URL(`${f.caseId}.json`,import.meta.url),JSON.stringify(f,null,2)+'\n');}
