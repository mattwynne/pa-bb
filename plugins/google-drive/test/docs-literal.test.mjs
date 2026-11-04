import test from 'node:test';
import assert from 'node:assert/strict';
import {richLiteralVector} from './docs-literal-fixtures.mjs';
import {inspectLiteralDocument,planLiteralEdit,literalRequests,literalReadbackMatches,literalSourceMatches} from '../core/docs-literal.mjs';
import {createDocsEditService} from '../core/docs-edit.mjs';
const prepare=v=>planLiteralEdit(inspectLiteralDocument(v.before,'doc-rich'),v.args);
test('rich document FIRST: logo/table elsewhere, partial stored style, astral indices, longer literal, independently authored whole wire/after',()=>{
 const v=richLiteralVector(),plan=prepare(v);
 assert.deepEqual({writeControl:{requiredRevisionId:plan.expectedRevisionId},requests:literalRequests(plan)},v.wire);
 assert.equal(literalReadbackMatches(v.before,v.after,v.args),true);
 const same=structuredClone(v.after);same.tabs[0].documentTab.body.content[1].paragraph.elements=[{startIndex:1,endIndex:17,textRun:{content:'Hello 😀 newer.\n',textStyle:{bold:true,italic:false,fontSize:{magnitude:12,unit:'PT'}}}}];assert.equal(literalReadbackMatches(v.before,same,v.args),true,'provider run coalescing is not content/style drift');
 const original=JSON.stringify(v.before);
 const mutations=[d=>{d.inlineObjects.logo.inlineObjectProperties.embeddedObject.title='changed';},d=>{d.opaqueMetadata.startIndex=1001;},d=>{d.tabs[1].documentTab.opaqueTab.endIndex=778;},d=>{d.tabs[0].documentTab.body.content[3].table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content='X\n';},d=>{d.tabs[0].documentTab.body.content[3].table.tableRows[0].tableCells[0].startIndex=20;},d=>{d.tabs[0].documentTab.body.content[1].paragraph.elements[1].textRun.textStyle.italic=true;},d=>{d.tabs[0].documentTab.body.content[1].paragraph.elements[1].textRun.content='wrong';},d=>{d.tabs[0].documentTab.namedStyles.styles[0].textStyle.weightedFontFamily.fontFamily='Other';},d=>{d.tabs[0].documentTab.body.content[4].paragraph.elements[0].textRun.textStyle.bold=true;}];
 for(const mutate of mutations){const after=structuredClone(v.after);mutate(after);assert.equal(literalReadbackMatches(v.before,after,v.args),false);}
 assert.equal(JSON.stringify(v.before),original);
});
test('expiring image read URLs may rotate without hiding image identity/source or opaque-field changes',()=>{
 const v=richLiteralVector(),current=structuredClone(v.before),image=d=>d.inlineObjects.logo.inlineObjectProperties.embeddedObject.imageProperties;
 image(current).contentUri='https://google.test/new-read-url';assert.equal(literalSourceMatches(v.before,current),true);
 image(v.after).contentUri='https://google.test/another-read-url';assert.equal(literalReadbackMatches(v.before,v.after,v.args),true);
 const missing=structuredClone(v.after);delete image(missing).contentUri;assert.equal(literalReadbackMatches(v.before,missing,v.args),false);
 const changed=structuredClone(v.after);image(changed).sourceUri='https://changed.example.test/source';assert.equal(literalReadbackMatches(v.before,changed,v.args),false);
 current.revisionId='new-revision';assert.equal(literalSourceMatches(v.before,current),false);
 v.before.opaqueMetadata.contentUri='opaque-before';v.after.opaqueMetadata.contentUri='opaque-after';assert.equal(literalReadbackMatches(v.before,v.after,v.args),false);
});
test('documented direct font weight400 equivalence is scoped to real text styles, not named definitions or opaque metadata',()=>{
 const v=richLiteralVector(),stored={weightedFontFamily:{fontFamily:'Arial'}};v.before.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle=stored;
 for(const p of v.after.tabs[0].documentTab.body.content[1].paragraph.elements)p.textRun.textStyle={weightedFontFamily:{fontFamily:'Arial',weight:400}};
 assert.equal(literalReadbackMatches(v.before,v.after,v.args),true);
 const wrong=structuredClone(v.after);wrong.tabs[0].documentTab.body.content[1].paragraph.elements[1].textRun.textStyle.weightedFontFamily.weight=700;assert.equal(literalReadbackMatches(v.before,wrong,v.args),false);
 const outside=structuredClone(v.after);outside.tabs[0].documentTab.namedStyles.styles[0].textStyle.weightedFontFamily.weight=400;assert.equal(literalReadbackMatches(v.before,outside,v.args),false);
 v.before.opaqueMetadata.weightedFontFamily={fontFamily:'Opaque'};v.after.opaqueMetadata.weightedFontFamily={fontFamily:'Opaque',weight:400};assert.equal(literalReadbackMatches(v.before,v.after,v.args),false);
});
for(const stored of [{},{bold:false},{weightedFontFamily:{fontFamily:'Arial'}},{foregroundColor:{color:{rgbColor:{blue:1}}}},{backgroundColor:{}}])test('supported partial style is copied/reset literally without inventing missing values: '+JSON.stringify(stored),()=>{
 const v=richLiteralVector();v.before.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle=structuredClone(stored);for(const p of v.after.tabs[0].documentTab.body.content[1].paragraph.elements)p.textRun.textStyle=structuredClone(stored);
 const plan=prepare(v),requests=literalRequests(plan);assert.deepEqual(requests[2].updateTextStyle.textStyle,stored);assert.equal(literalReadbackMatches(v.before,v.after,v.args),true);
});
for(const kind of ['shorter','delete','astral'])test('independent rich '+kind+' after and full wire preserve table/logo coordinates and scalar boundaries',()=>{
 const v=richLiteralVector(kind),plan=prepare(v);assert.deepEqual({writeControl:{requiredRevisionId:plan.expectedRevisionId},requests:literalRequests(plan)},v.wire);assert.equal(literalReadbackMatches(v.before,v.after,v.args),true);
 const bad=structuredClone(v.after);bad.tabs[0].documentTab.body.content[3].endIndex++;assert.equal(literalReadbackMatches(v.before,bad,v.args),false);
});
for(const fault of ['link','unknownStyle','invalidFont','unknownRegistry','suggestion','ambiguous','crossRun','tableTarget','stale','halfScalar','malformedTail','mixedStructure','unknownNeighbor'])test('rich target refuses '+fault+' before dispatch',()=>{
 const v=richLiteralVector(),p=v.before.tabs[0].documentTab.body.content[1].paragraph;
 if(fault==='link')p.elements[0].textRun.textStyle.link={url:'https://example.test'};
 if(fault==='unknownStyle')p.elements[0].textRun.textStyle.futureStyle=true;
 if(fault==='invalidFont')p.elements[0].textRun.textStyle.weightedFontFamily={weight:400};
 if(fault==='unknownRegistry')v.before.tabs[0].documentTab.namedRanges={range:{namedRanges:[]}};
 if(fault==='suggestion')p.elements[0].suggestedInsertionIds=['pending'];
 if(fault==='ambiguous'){v.args.oldText='l';}
 if(fault==='crossRun'){p.elements=[{startIndex:1,endIndex:11,textRun:{content:'Hello 😀 o'}},{startIndex:11,endIndex:15,textRun:{content:'ld.\n'}}];}
 if(fault==='tableTarget')v.args.oldText='Q';
 if(fault==='stale')v.args.expectedRevisionId='stale';
 if(fault==='halfScalar')v.args.oldText='\ud83d';
 if(fault==='malformedTail')v.before.tabs[0].documentTab.body.content[4].paragraph.elements[0].textRun.content='TailX';
 if(fault==='mixedStructure')v.before.tabs[0].documentTab.body.content[1].table={};
 if(fault==='unknownNeighbor')p.elements=[{startIndex:1,endIndex:10,textRun:{content:'Hello 😀 ',textStyle:{futureStyle:true}}},{startIndex:10,endIndex:15,textRun:{content:'old.\n',textStyle:{bold:true}}}];
 assert.throws(()=>prepare(v),e=>['unsupported_document','match_not_unique','stale_revision','invalid_input'].includes(e.docsCode));
});
test('rich new content can shrink/delete without a raw index or request escape hatch',()=>{
 const v=richLiteralVector(),p=prepare({...v,args:{...v.args,newText:''}});assert.deepEqual(literalRequests(p),[{deleteContentRange:{range:{tabId:'main',startIndex:10,endIndex:13}}}]);
 for(const newText of ['\ud800','x\ny','\u0001',v.args.oldText])assert.throws(()=>prepare({...v,args:{...v.args,newText}}));
});
function service(v,options={}){
 let current=v.before,posts=0,reviews=0;const logs=[];
 const core=createDocsEditService({store:{byEmail:async()=>({subject:'subject',email:v.args.account})},drive:{getFile:async()=>({id:'doc-rich',mimeType:'application/vnd.google-apps.document',trashed:false})},docs:{inspect:async()=>structuredClone(current),prepareWrite:async()=>({replace:async(p,signal,before)=>{await before();posts++;assert.deepEqual({writeControl:{requiredRevisionId:p.expectedRevisionId},requests:literalRequests(p.literal)},v.wire);if(options.lost)throw Error('PRIVATE_LOST');current=structuredClone(v.after);if(options.drift)options.drift(current);return {documentId:'doc-rich',replies:[{},{},{}],writeControl:{requiredRevisionId:'r2'}};}})},approve:async p=>{reviews++;assert.equal('literal'in p,false,'review only public exact change');if(options.approveHook)options.approveHook(current);return {outcome:'submitted',value:{approved:options.approved!==false}};},approvalRequired:async()=>options.policy!==false,diagnose:(stage,error)=>logs.push(stage)});
 return {core,get posts(){return posts;},get reviews(){return reviews;},logs};
}
test('actual existing service inspects -> preview -> owner review -> single rich edit -> whole raw verification',async()=>{
 const v=richLiteralVector(),w=service(v),inspection=await w.core.inspect(v.args);assert.equal(inspection.profile,'body-literal/1');assert.equal('raw'in inspection,false);assert.equal('data'in inspection.tabs[0],false);
 assert.equal((await w.core.replace(v.args)).outcome,'preview');assert.equal(w.posts,0);assert.equal(w.reviews,0);
 const result=await w.core.replace({...v.args,preview:false});assert.equal(result.outcome,'verified');assert.equal(result.approval,'owner_approved');assert.equal(w.posts,1);assert.equal(w.reviews,1);assert.match(result.verification,/stored text styles/);
});
for(const kind of ['declined','changedAfterReview','lost','preservationDrift','standing'])test('actual rich service '+kind+' retains approval/revision/uncertainty truth',async()=>{
 const v=richLiteralVector(),w=service(v,kind==='declined'?{approved:false}:kind==='changedAfterReview'?{approveHook:d=>{d.inlineObjects.logo.extra='changed';}}:kind==='lost'?{lost:true}:kind==='preservationDrift'?{drift:d=>{d.opaqueMetadata.keep='changed';}}:{policy:false});
 if(kind==='changedAfterReview'){await assert.rejects(w.core.replace({...v.args,preview:false}),e=>e.docsCode==='stale_revision');assert.equal(w.posts,0);return;}
 const result=await w.core.replace({...v.args,preview:false});assert.equal(result.outcome,{declined:'declined',lost:'uncertain',preservationDrift:'verification_unavailable',standing:'verified'}[kind]);assert.equal(w.posts,kind==='declined'?0:1);if(['lost','preservationDrift'].includes(kind))assert.equal(result.retrySafe,false);if(kind==='standing')assert.equal(w.reviews,0);
});
