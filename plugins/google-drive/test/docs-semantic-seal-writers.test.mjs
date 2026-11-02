import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoldSealService} from '../core/docs-semantic/bold-seal.mjs';
import {createDocsEditService} from '../core/docs-edit.mjs';
import {createDocsFormatService} from '../core/docs-format.mjs';
import {createDocsImageService} from '../core/docs-image.mjs';
import {createDocsCreationService} from '../core/docs-create.mjs';
import {createSheetsService} from '../core/sheets.mjs';
import {createCopyService} from '../core/copy.mjs';
import {createSharingAdapter} from '../adapters/sharing.mjs';
import {createSharingService} from '../core/sharing.mjs';
import {contextWorld,tableBytes,owner,keys,DOC,FOLDER} from './docs-semantic-target-context-fixtures.mjs';
import {validDraftDocument} from './docs-semantic-draft-fixtures.mjs';
const H='1'.repeat(64);
async function world(){const w=await contextWorld();w.seals=createBoldSealService({store:w.store,docs:w.docs,clock:()=>w.now});w.seal=()=>w.seals.sealBold(owner,w.input);return w;}
const attempt=async fn=>{try{return await fn();}catch(error){return {error};}};
function legacyDoc(){const d=validDraftDocument();d.tabs[0].documentTab.body.content.unshift({endIndex:1,sectionBreak:{}});d.tabs[0].documentTab.documentStyle={documentFormat:{documentMode:'PAGES'},pageSize:{width:{magnitude:595,unit:'PT'},height:{magnitude:842,unit:'PT'}}};return d;}
function contentRoute(w,kind,{account=owner.account,key=keys[1]}={}){
 let writes=0;const ports={store:w.store,drive:{getFile:async()=>({...w.files['draft-doc'],id:'draft-doc',mimeType:DOC,trashed:false})},docs:{inspect:async()=>legacyDoc(),prepareWrite:async()=>({replace:async(_a,_s,gate)=>{await gate?.();writes++;throw Error('SYNTHETIC_LOST_RESPONSE');},format:async(_a,_s,gate)=>{await gate?.();writes++;throw Error('SYNTHETIC_LOST_RESPONSE');},insertImage:async(_a,_s,gate)=>{await gate?.();writes++;throw Error('SYNTHETIC_LOST_RESPONSE');}})},approvalRequired:async()=>false,assets:{inspect:async()=>({mimeType:'image/png',width:100,height:50,bytes:128,sha256:H})},clock:()=>w.now};
 const args={account,operationId:key,document:'draft-doc',expectedRevisionId:'r1',preview:false};
 const service=kind==='replacement'?createDocsEditService(ports):kind==='image'?createDocsImageService(ports):createDocsFormatService(ports);
 const run=()=>kind==='replacement'?service.replace({...args,tabId:'tab-a',oldText:'A😀',newText:'Edited'}):kind==='image'?service.insert({...args,tabId:'tab-a',index:1,uri:'https://example.test/image.png',widthPt:100}):service.format({...args,ranges:kind==='page'?[]:[{tabId:'tab-a',startIndex:1,endIndex:6,textStyle:{bold:true}}],...(kind==='page'?{page:{tabId:'tab-a',backgroundColor:'#123456'}}:{})});
 return {run,writes:()=>writes};
}
for(const kind of ['replacement','format','page','image'])for(const oldFirst of [true,false])test(`actual ${kind} ${oldFirst?'held first blocks seal':'after genuine seal sends zero mutation'}`,async()=>{
 const w=await world();try{const route=contentRoute(w,kind);
  if(oldFirst){await route.run();assert.equal(route.writes(),1);const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);}
  else{await w.seal();await attempt(route.run);assert.equal(route.writes(),0);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}
 }finally{await w.close();}
});
for(const oldFirst of [true,false])test(`actual cross-subject formatting ${oldFirst?'held before seal':'after seal'} uses provider ID, not subject partition`,async()=>{
 const w=await world();try{const account='other-writer@example.test';await w.store.addAccount({subject:'other-writer',email:account,refreshToken:'UNUSED'});const route=contentRoute(w,'format',{account});if(oldFirst){await route.run();assert.equal(route.writes(),1);await assert.rejects(w.seal(),/conflict/);}else{await w.seal();await attempt(route.run);assert.equal(route.writes(),0);} }finally{await w.close();}
});
function native(w,{shared=false,onCreate=async()=>{},stopBeforePopulate=false,result='draft-doc'}={}){
 let creates=0,populates=0;
 const destination=shared?'foreign-folder':'root-concrete';
 const service=createDocsCreationService({store:w.store,drive:{getFile:async(_r,id)=>({id:id==='root'?'root-concrete':id,mimeType:FOLDER,trashed:false,capabilities:{canAddChildren:true}}),getSharingMetadata:async(_r,id)=>({id,owners:[{me:false}],shared:true}),listPermissions:async()=>({permissions:[]})},docs:{inspect:async()=>{if(stopBeforePopulate)throw Error('NO_POPULATE');const d=validDraftDocument();d.documentId=result;d.title='Created';d.tabs[0].documentTab.body.content=[{endIndex:1,sectionBreak:{}},{startIndex:1,endIndex:2,paragraph:{elements:[{startIndex:1,endIndex:2,textRun:{content:'\n'}}]}}];return d;}},creation:{prepare:async()=>({create:async()=>{creates++;await onCreate();return {id:result};},populate:async()=>{populates++;throw Error('SYNTHETIC_LOST_POPULATION');}})},assessment:{assessDestination:async()=>({destinationId:destination,fingerprint:H,path:'Synthetic',owners:[],audience:[],contextIds:[destination,'root-concrete'],allowedAccess:[]}),verifyCreated:async()=>true}});
 return {run:()=>service.create({account:owner.account,operationId:keys[1],folderId:shared?destination:'root',title:'Created',text:'Body'},undefined,async()=>({outcome:'submitted',value:{approved:true}})),creates:()=>creates,populates:()=>populates};
}
for(const shared of [false,true])test(`actual ${shared?'shared':'private'} native late-ID after seal retains ACK and sends zero population`,async()=>{
 const w=await world();try{const route=native(w,{shared,onCreate:async()=>{await w.seal();}});const r=await route.run();assert.equal(route.creates(),1);assert.equal(route.populates(),0);assert.notEqual(r.outcome,'verified');const facts=w.store.writers.get('docs_creations',keys[1]);assert.equal(facts.createAcknowledged,true);assert.equal(facts.createdId,'draft-doc');assert.equal(facts.blockedReason,'resource_conflict');assert.equal(facts.disposition,'held');assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');
 }finally{await w.close();}
});
for(const shared of [false,true])test(`actual ${shared?'shared':'private'} native creator attachment wins first and blocks seal`,async()=>{
 const w=await world();try{const route=native(w,{shared,stopBeforePopulate:true});await route.run();assert.equal(route.creates(),1);assert.equal(route.populates(),0);const facts=w.store.writers.get('docs_creations',keys[1]);assert.equal(facts.createAcknowledged,true);assert.equal(facts.createdId,'draft-doc');const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('actual native ACK blocked attachment remains a known-result blocker after competing claim releases and legacy says verified',async()=>{
 const w=await world();try{
  const route=native(w,{onCreate:async()=>{const format=createDocsFormatService({store:w.store,drive:{getFile:async()=>({id:'draft-doc',mimeType:DOC,trashed:false})},docs:{inspect:async()=>legacyDoc()},clock:()=>w.now});await format.format({account:owner.account,operationId:keys[2],document:'draft-doc',expectedRevisionId:'r1',ranges:[{tabId:'tab-a',startIndex:1,endIndex:6,textStyle:{bold:true}}],preview:true});assert.equal(await w.store.claimFormatting(keys[2],'draft-doc'),true);}});
  await route.run();assert.equal(route.populates(),0);const creation=await w.store.getCreation(keys[1]);await w.store.updateCreation({...creation,outcome:'verified'});
  const formatting=await w.store.getFormatting(keys[2]);await w.store.updateFormatting({...formatting,state:'not_submitted'},{kind:'knownNotSent'});
  const held=w.store.writers.get('docs_creations',keys[1]);assert.equal(held.createAcknowledged,true);assert.equal(held.createdId,'draft-doc');assert.ok(!held.grants.some(g=>g.id==='draft-doc'));assert.equal(held.disposition,'held');
  const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('actual lost shared-native result observed through replacement marker interlock blocks unmarked seal without target grant or ACK',async()=>{
 const w=await world();try{const route=native(w,{shared:true,onCreate:async()=>{throw Error('SYNTHETIC_LOST_CREATE_REPLY');}});await route.run();w.files['draft-doc'].appProperties={paDocsCreation:keys[1]};await attempt(contentRoute(w,'replacement',{key:keys[2]}).run);const held=w.store.writers.get('docs_creations',keys[1]);assert.equal(held.createAcknowledged,false);assert.equal(held.createdId,null);assert.deepEqual(held.observedIds,['draft-doc']);assert.ok(!held.grants.some(g=>g.id==='draft-doc'));delete w.files['draft-doc'].appProperties;const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
for(const shared of [false,true])test(`actual unrelated ${shared?'shared':'private'} Docs create/populate under common ancestor remains allowed`,async()=>{
 const w=await world();try{await w.seal();const route=native(w,{shared,result:'unrelated-native-doc'});await route.run();assert.equal(route.creates(),1);assert.equal(route.populates(),1);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}finally{await w.close();}
});
for(const shared of [false,true])test(`MIME-disjoint actual ${shared?'shared':'private'} Sheets creation/population is permitted under common root, not a Sheets-on-Doc success`,async()=>{
 const w=await world();try{
  await w.seal();let creates=0,populates=0;const destination=shared?'foreign-folder':'root-concrete';
  const raw={spreadsheetId:'unrelated-sheet',properties:{title:'Sheet'},sheets:[{properties:{sheetId:0}}]};
  const sheets={metadata:async()=>structuredClone(raw),blank:async()=>structuredClone(raw),creation:{prepare:async()=>({create:async()=>{creates++;return {id:'unrelated-sheet'};},populate:async()=>{populates++;throw Error('SYNTHETIC_LOST_SHEETS_REPLY');}})}};
  const service=createSheetsService({store:w.store,sheets,drive:{getFile:async(_r,id)=>({id:id==='root'?'root-concrete':id,mimeType:FOLDER,trashed:false,capabilities:{canAddChildren:true}}),getSharingMetadata:async(_r,id)=>({id,owners:[{me:false}],shared:true}),listPermissions:async()=>({permissions:[]})},assessment:{assessDestination:async()=>({destinationId:destination,fingerprint:H,path:'Synthetic',owners:[],audience:[],contextIds:[destination,'root-concrete'],allowedAccess:[]})}});
  await service.create({account:owner.account,operationId:keys[1],folderId:shared?destination:'root',title:'Sheet',tabs:[{title:'Plan',rows:[['Header'],['value']]}]},undefined,async()=>({outcome:'submitted',value:{approved:true}}));assert.equal(creates,1);assert.equal(populates,1);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');
 }finally{await w.close();}
});
function copyRoute(w,{source='source-file',result='draft-doc',duringVerify=async()=>{}}={}){
 let writes=0;
 const service=createCopyService({store:w.store,fileInfo:x=>x,drive:{getFile:async(_r,id)=>{if(id===source)return {id,name:'Copied',mimeType:DOC,trashed:false,capabilities:{canCopy:true}};if(id==='root')return {id:'root-concrete',mimeType:FOLDER,trashed:false,capabilities:{canAddChildren:true}};await duringVerify();throw Error('SYNTHETIC_PENDING_VERIFY');},prepareCopy:async()=>async()=>{writes++;return {id:result};}}});
 return {run:()=>service.copy({account:owner.account,operationId:keys[1],sourceId:source,folderId:'root'}),writes:()=>writes};
}
for(const marker of [false,true])test(`actual unresolved copy RESULT blocks seal despite role-compatible accessStable, marker=${marker}`,async()=>{
 const w=await world();try{let checked=false;const copy=copyRoute(w,{duringVerify:async()=>{
   checked=true;const op=await w.store.getCreation(keys[1]);assert.equal(op.acknowledged,true);assert.equal(op.outcome,'uncertain');assert.equal(op.fileId,'draft-doc');if(marker)w.files['draft-doc'].appProperties={paCopyCreation:keys[1]};
   const context=await (await import('../core/docs-semantic/bold-target-context.mjs')).createBoldTargetContextService({store:w.store,docs:w.docs,clock:()=>w.now}).inspectBoldTargetContext(owner,w.input);
   assert.equal(context.localCoordination.blockers.length,0);const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);
  }});await copy.run();assert.equal(copy.writes(),1);assert.equal(checked,true);
 }finally{await w.close();}
});
test('actual copy SOURCE content editing and common destination read/read remain supported',async()=>{
 const w=await world();try{let sealed=false;const copy=copyRoute(w,{source:'draft-doc',result:'unrelated-result',duringVerify:async()=>{assert.equal((await w.seal()).state,'sealed');sealed=true;}});await copy.run();assert.equal(copy.writes(),1);assert.equal(sealed,true);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}finally{await w.close();}
});
test('actual copy admitted after held seal reads source content without acquiring source contentWrite',async()=>{
 const w=await world();try{await w.seal();const copy=copyRoute(w,{source:'draft-doc',result:'unrelated-result'});await copy.run();assert.equal(copy.writes(),1);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}finally{await w.close();}
});
for(const marker of [false,true])test(`unknown folder RESULT matching actual ancestor blocks independently of roles, marker=${marker}`,async()=>{
 const w=await world();try{
  const p={operationId:keys[1],subject:owner.subject,kind:'folder',resource:'folder:foreign-folder',fileId:'foreign-folder',destinationId:'root-concrete',contextIds:['root-concrete','foreign-folder'],state:'proposed',fingerprint:H,destinationFingerprint:H,requestHash:H,titleHash:H};
  w.db.prepare('INSERT INTO drive_filing_operations VALUES (?,?,?,?,?)').run(keys[1],owner.subject,p.resource,'uncertain',JSON.stringify(p));if(marker)w.files['foreign-folder'].appProperties={paFilingCreation:keys[1]};
  const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
function sharingRoute(w,fileId){
 let writes=0;
 const adapter=createSharingAdapter({verifiedAccess:async()=> 'SYNTHETIC',drive:{getSharingMetadata:async(_r,id)=>{const key=id==='root'?'root-concrete':id,m=w.files[key]??w.files.root;return {id:key,name:'Synthetic',mimeType:key==='draft-doc'?DOC:FOLDER,trashed:false,shared:false,parents:m.parents,owners:[{me:true,emailAddress:owner.account}],capabilities:{canShare:true}};},listPermissions:async()=>({permissions:[{id:'owner-permission',type:'user',role:'owner',emailAddress:owner.account}]})},fetchImpl:async url=>{const u=new URL(url);if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/drive'});assert.match(u.pathname,/\/permissions/);writes++;throw Error('SYNTHETIC_LOST_PERMISSION_RESPONSE');}});
 const service=createSharingService({store:w.store,sharing:adapter,clock:()=>w.now,approve:async()=>({outcome:'submitted',value:{approved:true}})});
 return {run:()=>service.change({account:owner.account,operationId:keys[1],fileId,action:'grant',audience:{type:'user',emailAddress:'recipient@example.test'},role:'reader',preview:false}),writes:()=>writes};
}
for(const target of ['draft-doc','foreign-folder'])for(const oldFirst of [true,false])test(`actual sharing ${target} ${oldFirst?'first blocks seal':'after seal sends zero permissions POST'}`,async()=>{
 const w=await world();try{const route=sharingRoute(w,target);if(oldFirst){await route.run();assert.equal(route.writes(),1);const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);}else{await w.seal();await attempt(route.run);assert.equal(route.writes(),0);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}}finally{await w.close();}
});
