// Original inert source and expected facts. No production model/projector imports.
// Coordinates and IDs follow the literal provider tree, not captured outputs.
import {createHash} from 'node:crypto';
const clone=structuredClone;
export const selectionOwner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'};
export const selectionScope={tabs:{ids:['tab-d']},segments:[{kind:'body'}]};
export function paragraph(title,start,level,id){return {startIndex:start,endIndex:start+title.length+1,paragraph:{paragraphStyle:level?{namedStyleType:`HEADING_${level}`,headingId:id}:{},elements:[{startIndex:start,endIndex:start+title.length+1,textRun:{content:title+'\n'}}]}};}
// Exact structured read records for the literal eight-block body. These are
// original source-coordinate facts, not a stripped production model/projector.
export function selectionReadRecords(ns){const content=sectionDocument().tabs[0].documentTab.body.content,hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');return ns.map(n=>{const block=Math.floor((n-2)/2),raw=content[block],paragraph=n%2===0;return {id:`s02-a:${n}`,kind:paragraph?'paragraph':'text',parent:paragraph?'s02-a:1':`s02-a:${n-1}`,tabId:'tab-d',segment:{kind:'body'},extent:{start:1+2*block,end:3+2*block},extentStatus:'mapped',children:paragraph?[`s02-a:${n+1}`]:[],...paragraph?{list:null,positionedObjectIds:[]}:{text:['A','x','B','y','C','z','D','w'][block]+'\n'},evidenceDigest:hash(paragraph?raw:raw.paragraph.elements[0])};});}
export const selectionMetadata={id:'doc-s02',name:'Original selection',mimeType:'application/vnd.google-apps.document',version:'17',capabilities:{canEdit:true}};
export function sectionDocument(){return {documentId:'doc-s02',revisionId:'docs-r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-d',title:'Main',index:7},documentTab:{body:{content:[paragraph('A',1,1,'id-A'),paragraph('x',3),paragraph('B',5,3,'id-B'),paragraph('y',7),paragraph('C',9,2,'id-C'),paragraph('z',11),paragraph('D',13,1,'id-D'),paragraph('w',15)]}}}]};}
export function sectionOutline(snapshot='s02-a',tab='tab-d'){return [['A','id-A',1,0,['A'],2,1,13,14],['B','id-B',3,1,['A','B'],6,5,9,10],['C','id-C',2,1,['A','C'],10,9,13,14],['D','id-D',1,0,['D'],14,13,17,null]].map(([title,providerId,level,depth,path,n,start,end,next])=>({node:`${snapshot}:${n}`,providerId,title,level,tabId:tab,segment:{kind:'body'},extent:{start,end},link:`https://docs.google.com/document/d/doc-s02/edit?tab=${encodeURIComponent(tab)}#heading=${encodeURIComponent(providerId)}`,path,depth,sectionEnd:next?{kind:'nextHeading',node:`${snapshot}:${next}`}:{kind:'segmentBoundary',node:`${snapshot}:16`}}));}
const ids=(a,b)=>Array.from({length:b-a+1},(_,i)=>`s02-a:${a+i}`);
const section=(heading,start,end,includeHeading,nodes)=>({status:'resolved',snapshotId:'s02-a',nodes,candidates:[],readProof:false,section:{heading:`s02-a:${heading}`,start,end,includeHeading}});
const nodes=(ns,kinds)=>({status:ns.length?'resolved':'missing',snapshotId:'s02-a',nodes:ns,candidates:ns.map((node,i)=>({node,kind:kinds[i]})),readProof:false});
const op=(selector,expected,error,scope=selectionScope)=>({operation:'selector',scope:clone(scope),selector,expected,...error?{error}:{}});
const B=includeHeading=>({section:{headingId:'id-B',includeHeading}});
export function tabDocument(duplicate=false){const t=(tabId,title,index,text,children=[])=>({tabProperties:{tabId,title,index},documentTab:{body:{content:[paragraph(text,1)]}},...children.length?{childTabs:children}:{}});return {documentId:'doc-s02',revisionId:'docs-r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[t('A','Main',7,'a',[t('B','Child',9,'b')]),t('C',duplicate?'Main':'Sibling',1,'c',duplicate?[t('E','Child',3,'e')]:[])]};}
const scope=tabs=>({tabs,segments:[{kind:'body'}]});
const tabResult=(tabs,roots,ns)=>({status:'resolved',tabs,roots,nodes:ns});
const tabB=tabResult(['B'],['s02-a:4'],ids(4,6));
const tabAll=tabResult(['A','B','C'],['s02-a:1','s02-a:4','s02-a:7'],ids(1,9));
const tabOp=(input,tabs,expected,error)=>({operation:'tab',input,scope:scope(tabs),parsed:{documentId:'doc-s02',urlTab:input.includes('tab=')?'B':null},expected,...error?{error}:{}});
export function selectionFixture(r){
 const f={provenance:{source:'selection-fixtures.mjs: original literal provider coordinates and expected selections',authorship:'Inert independently authored raw source/outline/links/intervals/nodes; no production oracle imports'},caseId:r.caseId,variant:r.base,outcome:r.outcomeVariant,document:sectionDocument(),metadata:clone(selectionMetadata),outline:sectionOutline(),checks:[]};
 if(r.ledgerId==='C004'){
  f.operation='outline';f.depth=r.base==='depth'?0:32;f.pageBytes=3000;
  if(r.base==='deepLinks'){
   f.document.tabs[0].documentTab.body.content[0].paragraph.paragraphStyle.headingId='id /?😀';
   f.outline[0].providerId='id /?😀';f.outline[0].link='https://docs.google.com/document/d/doc-s02/edit?tab=tab-d#heading=id%20%2F%3F%F0%9F%98%80';
  }
  if(['bounds','wrongSubject'].includes(r.outcomeVariant)){
   f.depth=r.base==='depth'?32:f.depth;
   const content=f.document.tabs[0].documentTab.body.content;
   for(let i=0;i<32;i++){
    const title=`Tail ${i} `+'😀'.repeat(12),start=17+i*34,end=start+34,n=18+2*i,providerId=`tail-${i} /😀`;
    // 8..9 ASCII units + 24 UTF-16 emoji units + LF: pad to 34 exactly.
    const text=title.padEnd(33,'x');content.push(paragraph(text,start,i%2?6:1,providerId));
    if(i===0){f.outline[3].extent.end=17;f.outline[3].sectionEnd={kind:'nextHeading',node:'s02-a:18'};}
    const last=i===31,level=i%2?6:1,nextIndex=level===1?i+2:i+1;
    f.outline.push({node:`s02-a:${n}`,providerId,title:text,level,tabId:'tab-d',segment:{kind:'body'},extent:{start,end:nextIndex<32?17+nextIndex*34:17+32*34},link:`https://docs.google.com/document/d/doc-s02/edit?tab=tab-d#heading=${encodeURIComponent(providerId)}`,path:level===1?[text]:[content[8+i-1].paragraph.elements[0].textRun.content.slice(0,-1),text],depth:level===1?0:1,sectionEnd:nextIndex<32?{kind:'nextHeading',node:`s02-a:${18+2*nextIndex}`}:{kind:'segmentBoundary',node:'s02-a:80'}});
   }
   if(r.base==='sectionExtent'){
    content.push({startIndex:1105,paragraph:{elements:[]}});
    f.outline.at(-1).extent=null;f.outline.at(-1).sectionEnd={kind:'observedMaximum'};
    f.outline.at(-2).extent=null;f.outline.at(-2).sectionEnd={kind:'observedMaximum'};
   }
  }
  if(r.outcomeVariant==='preservation'){
   const tab=f.document.tabs[0],b=tab.documentTab;
   b.body.content[0].paragraph.elements[0].textRun.textStyle={bold:true};
   b.body.content[4].paragraph.elements[0].textRun.content='B\n';f.outline[2].title='B';f.outline[2].path=['A','B'];
   b.headers={hdr:{content:[paragraph('B',1,3,'id-B')]}};
   tab.childTabs=[{tabProperties:{tabId:'child',title:'Nested',index:19},documentTab:{body:{content:[paragraph('B',1,3,'id-B')]}}}];
   for(const [node,tabId,segment]of [[19,'tab-d',{kind:'header',id:'hdr'}],[22,'child',{kind:'body'}]])f.outline.push({node:`s02-a:${node}`,providerId:'id-B',title:'B',level:3,tabId,segment,extent:{start:1,end:3},link:`https://docs.google.com/document/d/doc-s02/edit?tab=${tabId}#heading=id-B`,path:['B'],depth:0,sectionEnd:{kind:'segmentBoundary',node:`s02-a:${node}`}});
  }
  f.expectedOutline=f.outline.filter(h=>h.tabId==='tab-d'&&h.segment.kind==='body'&&h.depth<=f.depth);
  f.outlineProbes=[];
  if(r.base==='sectionExtent'&&r.outcomeVariant==='bounds'){
   const document=sectionDocument(),outline=sectionOutline('outline-probe');delete document.tabs[0].documentTab.body.content[6].endIndex;
   outline[0].extent=null;outline[0].sectionEnd={kind:'unresolvedHeading',node:'outline-probe:14'};
   outline[2].extent=null;outline[2].sectionEnd={kind:'unresolvedHeading',node:'outline-probe:14'};
   outline[3].extent=null;
   f.outlineProbes.push({document,outline});
  }
  f.invalid=r.outcomeVariant==='invalid'?{headingIds:'extent',levels:'extent',depth:'schema',deepLinks:'invalid',sectionExtent:'extent'}[r.base]:null;
  f.invalidChecks=[];
  if(r.outcomeVariant==='invalid'){
   if(r.base==='depth')for(const outlineDepth of [0.5,33])f.invalidChecks.push({outlineDepth,error:'schema'});
   if(r.base==='headingIds'){const d=clone(f.document);d.tabs[0].documentTab.body.content[0].paragraph.paragraphStyle.headingId={malformed:'PRIVATE_ID'};f.invalidChecks.push({document:d,error:'invalid'});}
  }
  f.invalidDocument=clone(f.document);
  if(f.invalid==='extent')f.invalidDocument.tabs[0].documentTab.body.content[0].paragraph.elements[0].endIndex=4;
  f.invalidInput=r.base==='deepLinks'?'https://evil.example/document/d/doc-s02/edit':'doc-s02';
  return f;
 }
 if(r.ledgerId==='C016'){
  const success={headingId:op(B(false),section(6,7,9,false,ids(8,9))),headingPath:op({section:{path:['A','B'],includeHeading:false}},section(6,7,9,false,ids(8,9))),level:op({section:{text:'B',level:3,includeHeading:false}},section(6,7,9,false,ids(8,9))),peerBoundary:op({section:{headingId:'id-A',includeHeading:false}},section(2,3,13,false,ids(4,13))),includeHeading:op(B(true),section(6,5,9,true,ids(6,9)))};
  f.control=success[r.base];f.primary=clone(f.control);
  if(r.outcomeVariant==='counterexample'){
   if(r.base==='headingId')f.primary=op({section:{headingId:'B',includeHeading:false}},{status:'missing',candidates:[],nodes:[]});
   if(r.base==='headingPath')f.primary=op({section:{path:['B'],includeHeading:false}},{status:'missing',candidates:[],nodes:[]});
   if(r.base==='level')f.primary=op({section:{text:'B',level:2,includeHeading:false}},{status:'missing',candidates:[],nodes:[]});
   if(r.base==='peerBoundary'){f.document.tabs[0].documentTab.body.content.push({startIndex:17,paragraph:{elements:[]}});f.outline[3].extent=null;f.outline[3].sectionEnd={kind:'observedMaximum'};f.primary=op({section:{headingId:'id-D',includeHeading:false}},{status:'unresolved',reason:'sectionExtents',nodes:[],candidates:[{node:'s02-a:14'}]});}
   if(r.base==='includeHeading')f.primary=op({section:{headingId:'id-B'}},undefined,'invalid');
  }
  f.checks=[op({section:{headingId:'id-B',includeHeading:false,before:{headingId:'absent'}}},{status:'missing',candidates:[],nodes:[],boundary:'explicitEnd'}),op({section:{headingId:'id-B',includeHeading:false,before:{headingId:'id-A'}}},undefined,'scope'),op({section:{headingId:'id-B',includeHeading:false,before:{headingId:'id-D'}}},section(6,7,13,false,ids(8,13))),op(B(false),section(6,7,9,false,ids(8,9)))];
  if(r.base==='headingId'){
   const d=sectionDocument();d.tabs[0].documentTab.headers={hdr:{content:[paragraph('B',1,3,'id-B')]}};
   const header={node:'s02-a:19',providerId:'id-B',title:'B',level:3,tabId:'tab-d',segment:{kind:'header',id:'hdr'},extent:{start:1,end:3},link:'https://docs.google.com/document/d/doc-s02/edit?tab=tab-d#heading=id-B',path:['B'],depth:0,sectionEnd:{kind:'segmentBoundary',node:'s02-a:19'}};
   f.checks.push({...op(B(false),{status:'ambiguous',candidates:[sectionOutline()[1],header],nodes:[]},undefined,{tabs:{ids:['tab-d']},segments:[{kind:'body'},{kind:'header',id:'hdr'}]}),snapshotDocument:d});
  }
  if(r.base==='headingPath'){
   const d=sectionDocument(),content=d.tabs[0].documentTab.body.content;content.push(paragraph('A',17,1,'second-A'),paragraph('B',19,3,'second-B'));
   const first=sectionOutline()[1],second={...first,node:'s02-a:20',providerId:'second-B',extent:{start:19,end:21},link:'https://docs.google.com/document/d/doc-s02/edit?tab=tab-d#heading=second-B',sectionEnd:{kind:'segmentBoundary',node:'s02-a:20'}};
   f.checks.push({...op({section:{path:['A','B'],includeHeading:false}},{status:'ambiguous',candidates:[first,second],nodes:[]}),snapshotDocument:d});
  }
  if(r.base==='includeHeading'){
   const d=sectionDocument();d.tabs[0].documentTab.body.content=[paragraph('B',1,1,'id-B'),paragraph('C',3,1,'id-C')];
   f.checks.push({...op(B(false),section(2,3,3,false,[])),snapshotDocument:d},{...op(B(true),section(2,1,3,true,ids(2,3))),snapshotDocument:d});
  }
 }
 if(r.ledgerId==='C017'){
  const success={node:op({node:'s02-a:6'},nodes(['s02-a:6'],['paragraph'])),span:op({span:{from:'s02-a:4',to:'s02-a:10'}},nodes([4,6,8,10].map(n=>`s02-a:${n}`),Array(4).fill('paragraph'))),staleOrdinal:tabOp('doc-s02',{ordinal:1,snapshotId:'s02-a'},tabB),transformedIdentity:{operation:'identity',duplicate:false}};
  f.control=success[r.base];f.primary=clone(f.control);
  if(r.base==='staleOrdinal'){f.document=tabDocument();f.outline=[];}
  if(r.base==='transformedIdentity'){f.primary.duplicate=r.outcomeVariant==='counterexample';}
  if(r.outcomeVariant==='counterexample'){
   if(r.base==='node')f.primary=op({node:'old:6'},nodes([],[]));
   if(r.base==='span')f.primary=op({span:{from:'s02-a:10',to:'s02-a:4'}},undefined,'scope');
   if(r.base==='staleOrdinal')f.primary=tabOp('doc-s02',{ordinal:1,snapshotId:'old'},undefined,'snapshot');
  }
  if(r.base==='span')f.checks=[op({span:{from:'s02-a:4',to:'s02-a:5'}},nodes([],[])),op({span:{from:'s02-a:6',to:'s02-a:6'}},nodes(['s02-a:6'],['paragraph']))];
 }
 if(r.ledgerId==='C020'){
  f.document=tabDocument();f.outline=[];
  const good={url:tabOp('https://docs.google.com/document/d/doc-s02/edit?tab=B#tab=B',{ids:['B']},tabB),id:tabOp('doc-s02',{ids:['B']},tabB),path:tabOp('doc-s02',{path:['Main','Child']},tabB),conflictingUrl:tabOp('https://docs.google.com/document/d/doc-s02/edit?tab=B',{ids:['B']},tabB),noImplicitFirst:tabOp('doc-s02',{all:true},tabAll)};
  f.control=good[r.base];f.primary=clone(f.control);
  if(r.outcomeVariant==='counterexample'){
   if(r.base==='url')f.primary=tabOp('https://docs.google.com/document/d/doc-s02/edit?tab=B&tab=B',{ids:['B']},undefined,'conflict');
   if(r.base==='id')f.primary=tabOp('doc-s02',{ids:['missing']},undefined,'scope');
   if(r.base==='path')f.primary=tabOp('doc-s02',{path:['Child']},{status:'missing',candidates:[],nodes:[],roots:[]});
   if(r.base==='conflictingUrl')f.primary=tabOp('https://docs.google.com/document/d/doc-s02/edit?tab=B',{ids:['A']},undefined,'conflict');
   if(r.base==='noImplicitFirst'){f.primary=tabOp('https://docs.google.com/document/d/doc-s02/edit?tab=B',undefined,undefined,'scope');delete f.primary.scope.tabs;}
  }
  if(r.base==='path'){
   const d=tabDocument(true);f.pathProbe={...tabOp('doc-s02',{path:['Main','Child']},{status:'ambiguous',candidates:[{tabId:'B',title:'Child',parent:'A'},{tabId:'E',title:'Child',parent:'C'}],nodes:[],roots:[]}),snapshotDocument:d};
  }
  f.checks=[...f.pathProbe?[f.pathProbe]:[],tabOp('https://docs.google.com/document/d/doc-s02/edit#tab=B',{ids:['B']},tabB),tabOp('https://docs.google.com/document/d/doc-s02/edit?tab=B#tab=C',{ids:['B']},undefined,'conflict'),tabOp('doc-s02',{ids:['A','B']},tabResult(['A','B'],['s02-a:1','s02-a:4'],ids(1,6)))];
 }
 return f;
}
