import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {sourceDigest} from '../features/docs/coverage/runner.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createBbStore} from '../adapters/bb-store.mjs';
import {createGoogleAdapter} from '../adapters/google.mjs';
import {createDocsFormatService} from '../core/docs-format.mjs';
import {createDocsImageService} from '../core/docs-image.mjs';
import {createBoldSealService} from '../core/docs-semantic/bold-seal.mjs';
import {createRecoveryService} from '../core/docs-semantic/recovery.mjs';
import {createRecoveryReadStore} from '../adapters/docs-recovery-store.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
import {createOperationStatusHandler} from '../docs-operation-status-tools.mjs';
import {catalogHandle} from '../core/docs-semantic/draft-catalog.mjs';
import {document,account,record} from './docs-fixtures.mjs';
import {nativeWorld,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {textWorld} from './docs-semantic-text-fixtures.mjs';
import {weightVector} from './docs-semantic-weight-vectors.mjs';
const recoveryProofs=[],trapCalibrations=[];
after(()=>{if(process.env.DOCS_RECOVERY_PROOF_DIR)writeFileSync(join(process.env.DOCS_RECOVERY_PROOF_DIR,`sdk-no-write-${process.pid}.json`),JSON.stringify({producerPid:process.pid,sourceDigest:sourceDigest(),trapCalibrations,proofs:recoveryProofs},null,2)+'\n');});
const key='11111111-1111-4111-8111-111111111111',hash=x=>createHash('sha256').update(x).digest('hex');
function snapshot(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));}
function noWrites(store,violations=[]){
 const deny=key=>{violations.push(String(key));throw Error('FORBIDDEN non-read store port');};
 const nested=(target,allowed)=>new Proxy(target,{get(t,key){return allowed.includes(key)?t[key].bind(t):deny(key);}});
 return new Proxy(store,{get(target,key){if(key==='byEmail')return target[key].bind(target);if(key==='semanticDrafts')return nested(target[key],['byId']);if(key==='semanticExecutions')return nested(target[key],['byId','evidence']);return deny(key);}});
}
function install(w,fetchImpl,clock=Date.now){
 w.forbidden=[];const prepare=w.db.prepare.bind(w.db);w.db.prepare=sql=>{if(w.statusReading&&!/^\s*(SELECT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)){w.forbidden.push('SQL write preparation');throw Error('FORBIDDEN SQL mutation');}return prepare(sql);};
 const exec=w.db.exec.bind(w.db),pragma=w.db.pragma.bind(w.db);
 w.db.exec=(...args)=>{if(w.statusReading){w.forbidden.push('SQL exec');throw Error('FORBIDDEN SQL exec');}return exec(...args);};
 w.db.pragma=(...args)=>{if(w.statusReading){w.forbidden.push('SQL pragma');throw Error('FORBIDDEN SQL pragma');}return pragma(...args);};
 w.outerCalls=[];
 const observedFetch=async(url,init)=>{
  const call={url:String(url),method:init?.method??'GET',inTransaction:w.db.inTransaction};w.outerCalls.push(call);
  assert.equal(call.method,'GET','actual OUTER status HTTP port is GET-only');assert.equal(call.inTransaction,false,'actual OUTER HTTP port has no SQL transaction');
  return fetchImpl(url,init);
 };
 const handler=createOperationStatusHandler({bb:w.h.bb,db:w.db,store:noWrites(w.store,w.forbidden),fetchImpl:observedFetch,clock});w.h.bb.agents.registerTool(handler.definition);
 return async input=>{
  assert.equal(w.db.pragma('query_only',{simple:true}),1,'actual facade connection rejects all SQL writes');
  const before=snapshot(w.db),start=w.outerCalls.length,worldStart=w.calls.length;let result;w.statusReading=true;
  try{result=parse(await w.h.harness.behavior.callAgentTool('docs_operation_status',input,{threadId:'DIFFERENT_RECOVERY_THREAD'}));return result;}
  finally{
   w.statusReading=false;const current=snapshot(w.db),calls=w.outerCalls.slice(start),worldCalls=w.calls.slice(worldStart);
   recoveryProofs.push({tool:'docs_operation_status',threadId:'DIFFERENT_RECOVERY_THREAD',queryOnly:true,providerCounterBoundary:'complete outer status fetch',providerTransactionStates:calls.map(c=>c.inTransaction),noNetworkInTransaction:calls.every(c=>c.inTransaction===false),allTablesBeforeSha256:hash(JSON.stringify(before)),allTablesAfterSha256:hash(JSON.stringify(current)),allRowsEqual:isDeepStrictEqual(before,current),accountsEqual:isDeepStrictEqual(before.drive_accounts,current.drive_accounts),forbiddenStoreOrSqlAttempts:w.forbidden.length,providerMethods:calls.map(c=>c.method),underlyingWorldRecordedMethods:worldCalls.map(c=>c.method),providerMutationCount:calls.filter(c=>c.method!=='GET').length,status:result?.status??'schemaError',observation:result?.observation?.kind??null,historicalEvidenceVersion:result?.historicalEvidenceVersion??null});
   assert.ok(calls.every(c=>c.method==='GET'&&c.inTransaction===false),'OUTER HTTP method/transaction failures cannot be masked by handler unavailable');
   assert.deepEqual(w.forbidden,[],'NO attempted mutating store/prepare/exec/pragma, even when caught');
  }
 };
}
function imageAfter(){return {documentId:'doc-a',revisionId:'rev-b',suggestionsViewMode:'SUGGESTIONS_INLINE',title:'Synthetic fixture only',tabs:[{tabProperties:{tabId:'tab-a',title:'Main'},documentTab:{body:{content:[{endIndex:1,sectionBreak:{}},{startIndex:1,endIndex:11,paragraph:{elements:[{startIndex:1,endIndex:2,inlineObjectElement:{inlineObjectId:'logo'}},{startIndex:2,endIndex:11,textRun:{content:'Wordmark\n',textStyle:{bold:true}}}]}}]},inlineObjects:{logo:{objectId:'logo',inlineObjectProperties:{embeddedObject:{size:{width:{magnitude:144,unit:'PT'},height:{magnitude:36,unit:'PT'}},imageProperties:{sourceUri:'https://example.test/logo.png',contentUri:'https://google.test/transient'}}}}}}}]};}
async function legacy(kind,{path,produce=true,title}={}){
 const dir=path?null:mkdtempSync(join(tmpdir(),'readonly-recovery-')),file=path??join(dir,'history.db'),h=createFakePluginHost({pluginId:'readonly-recovery'}),db=new (h.bb.storage.database().constructor)(file),store=createBbStore(db,h.bb.storage.migrate);h.bb.onDispose(()=>{if(db.open)db.close();});
 if(!await store.bySubject(record.subject))await store.addAccount({...record,refreshToken:'SECRET_REFRESH',accessToken:'SECRET_ACCESS',expiresAt:Date.now()+600000});
 const before=document('Wordmark\n');if(title!==undefined)before.title=title;if(kind==='format')before.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold=false;
 if(kind==='page'){
  const data=before.tabs[0].documentTab;data.documentStyle={documentFormat:{documentMode:'PAGES'},marginTop:{magnitude:72,unit:'PT'}};
  data.body.content.push({startIndex:10,endIndex:12,table:{tableRows:[{tableCells:[{content:[{startIndex:1,endIndex:2,paragraph:{elements:[{startIndex:1,endIndex:2,textRun:{content:'\n'}}]}}]}]}]}});
 }
 const after=kind==='image'?imageAfter():structuredClone(before);after.revisionId='rev-b';if(kind==='format')after.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold=true;if(kind==='page')after.tabs[0].documentTab.documentStyle.marginTop.magnitude=54;
 const w={h,db,store,file,dir,now:Date.now(),document:produce?before:after,calls:[],onGet:async()=>{},identity:{sub:record.subject,email:account,email_verified:true},override:null};
 w.fetch=async(url,init={})=>{
  const u=new URL(url),method=init.method??'GET';w.calls.push({url:String(url),method});assert.equal(db.inTransaction,false,'no network inside local transaction');
  if(w.override){const result=await w.override(u,init);if(result)return result;}
  if(u.pathname.endsWith('/userinfo'))return Response.json(w.identity);
  if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/drive.file'});
  if(u.pathname.endsWith(':batchUpdate')){
   assert.equal(method,'POST');const body=JSON.parse(init.body);assert.deepEqual(body.writeControl,{requiredRevisionId:'rev-a'});assert.equal(body.requests.length,1);
   if(kind==='page')assert.deepEqual(body.requests,[{updateDocumentStyle:{tabId:'tab-a',documentStyle:{marginTop:{magnitude:54,unit:'PT'}},fields:'marginTop'}}]);
   if(kind==='image')assert.deepEqual(body.requests,[{insertInlineImage:{uri:'https://example.test/logo.png',location:{tabId:'tab-a',index:1},objectSize:{width:{magnitude:144,unit:'PT'}}}}]);
   w.document=structuredClone(after);return Response.json({documentId:'doc-a',replies:[kind==='image'?{insertInlineImage:{objectId:'logo'}}:{}],writeControl:{requiredRevisionId:'rev-b'}});
  }
  if(u.hostname==='docs.googleapis.com'){await w.onGet();return Response.json(w.document);}
  if(u.pathname.includes('/drive/v3/files/'))return Response.json({id:'doc-a',name:'Synthetic fixture only',mimeType:'application/vnd.google-apps.document',trashed:false,parents:['root-concrete']});
  throw Error('SECRET_UNEXPECTED_CLOSED_HTTP');
 };
 if(produce){
  const adapter=createGoogleAdapter({store,getClient:async()=>({clientId:'SECRET_CLIENT',clientSecret:'SECRET_CLIENT_SECRET'}),fetchImpl:w.fetch});
  if(kind==='image'){
   const service=createDocsImageService({store,drive:adapter.drive,docs:adapter.docs,approvalRequired:async()=>false,assets:{inspect:async()=>({mimeType:'image/png',width:400,height:100,bytes:4096,sha256:'a'.repeat(64)})}});
   assert.equal((await service.insert({account,document:'doc-a',operationId:key,expectedRevisionId:'rev-a',tabId:'tab-a',index:1,uri:'https://example.test/logo.png',widthPt:144,preview:false})).outcome,'verified');
  }else{
   const service=createDocsFormatService({store,drive:adapter.drive,docs:adapter.docs,approvalRequired:async()=>false});
   assert.equal((await service.format({account,document:'doc-a',operationId:key,expectedRevisionId:'rev-a',ranges:kind==='page'?[]:[{tabId:'tab-a',startIndex:1,endIndex:10,textStyle:{bold:true}}],...(kind==='page'?{page:{tabId:'tab-a',marginTopPt:54}}:{}),preview:false})).outcome,'verified');
  }
 }
 w.calls=[];w.status=install(w,async(url,init)=>{assert.equal(init.method,'GET','STRICT status GET-only');return w.fetch(url,init);},()=>w.now);w.close=()=>h.harness.lifecycle.dispose();return w;
}
for(const kind of ['format','page','image'])test(`actual ${kind} producer then SDK K6 read-only own-ACK observation and file reopen`,async()=>{
 const w=await legacy(kind);let reopened;
 try{
  const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await w.status({account,operationId:key});assert.equal(r.status,'verified');assert.equal(r.observation.kind,'observed_matching');assert.equal(r.observation.savedRevisionMatch,true);assert.equal(r.retrySafe,false);assert.equal(r.thisCall.providerMutationCount,0);assert.deepEqual(snapshot(w.db),before);assert.equal(w.calls.length,3);assert.ok(w.calls.every(c=>c.method==='GET'));
  if(kind==='page'){w.document.tabs[0].documentTab.body.content[2].table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content='opaque drift\n';const drift=await w.status({account,operationId:key});assert.equal(drift.status,'verified');assert.equal(drift.observation.kind,'observed_mismatch');assert.deepEqual(snapshot(w.db),before);}
  const file=w.file;await w.close();reopened=await legacy(kind,{path:file,produce:false});const againBefore=snapshot(reopened.db);reopened.db.pragma('query_only = ON');assert.equal((await reopened.status({account,operationId:key})).observation.kind,'observed_matching');assert.deepEqual(snapshot(reopened.db),againBefore);
 }finally{await reopened?.close();await w.close();if(w.dir)rmSync(w.dir,{recursive:true,force:true});}
});
test('strict cached credentials: expired0 GET, 401/drift one GET, no refresh/cache changes or unsafe diagnostics',async()=>{
 const w=await legacy('format');try{
  for(const mode of ['expired','disabled','401','email','subject','oversize','redirect','truncated']){
   w.db.pragma('query_only = OFF');w.db.prepare('UPDATE drive_accounts SET expires_at=?,access_token=?').run(mode==='expired'?1:Date.now()+600000,mode==='disabled'?null:'SECRET_ACCESS');w.calls=[];w.identity={sub:mode==='subject'?'OTHER_PRIVATE_SUBJECT':record.subject,email:mode==='email'?'PRIVATE_CHANGED_EMAIL':account,email_verified:true};
   w.override=async(u)=>mode==='401'&&u.pathname.endsWith('/userinfo')?Response.json({secret:'PRIVATE_BODY'},{status:401}):u.hostname==='docs.googleapis.com'&&mode==='oversize'?new Response('PRIVATE_BODY',{headers:{'content-length':'1048577'}}):u.hostname==='docs.googleapis.com'&&mode==='redirect'?new Response('PRIVATE_BODY',{status:302}):u.hostname==='docs.googleapis.com'&&mode==='truncated'?new Response('{PRIVATE_TRUNCATED'):null;
   const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await w.status({account,operationId:key});assert.equal(r.observation.kind,'unavailable',mode);assert.deepEqual(snapshot(w.db),before);assert.ok(w.calls.every(c=>c.method==='GET'));if(['expired','disabled'].includes(mode))assert.equal(w.calls.length,0);if(['401','email','subject'].includes(mode))assert.equal(w.calls.length,1);
  }
  assert.doesNotMatch(JSON.stringify(w.h.harness.inspection.logEntries),/SECRET_|PRIVATE_|writer@example|Wordmark/);
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
test('cached credential expiry during each GET await stops further reads without refresh or persistence',async()=>{
 const w=await legacy('format');try{
  for(const boundary of ['userinfo','metadata','document']){
   w.now=Date.now();w.calls=[];w.override=async u=>{if(boundary==='userinfo'&&u.pathname.endsWith('/userinfo')||boundary==='metadata'&&u.pathname.includes('/drive/v3/files/')||boundary==='document'&&u.hostname==='docs.googleapis.com')w.now+=1000000;return null;};
   const before=snapshot(w.db);w.db.pragma('query_only = ON');const result=await w.status({account,operationId:key});assert.equal(result.observation.kind,'unavailable');assert.equal(w.calls.length,boundary==='userinfo'?1:boundary==='metadata'?2:3);assert.ok(w.calls.every(c=>c.method==='GET'));assert.deepEqual(snapshot(w.db),before);
  }
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
test('SQL older JSON lifecycle/no ACK/current image match never saves, backfills, releases or creates ACK',async()=>{
 const w=await legacy('image');try{
  const p=await w.store.images.get(key);delete p.appliedRevision;delete p.objectId;p.state='reviewing';p.writeAttempted=null;
  w.db.prepare('UPDATE docs_image_operations SET state=?,receipt=? WHERE operation_id=?').run('uncertain',JSON.stringify(p),key);
  const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await w.status({account,operationId:key});assert.equal(r.status,'uncertain');assert.equal(r.legacyFacts.json.state,'reviewing');assert.equal(r.legacyFacts.json.writeAttempted,null);assert.equal(r.observation.kind,'observed_matching');assert.equal(r.observation.savedRevisionMatch,false);assert.equal(r.stages,undefined);assert.equal(r.legacyFacts.json.appliedRevision,undefined);assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
test('selected receipt advanced by a distinct writer mid-GET invalidates attribution with no facade write',async()=>{
 const w=await legacy('format'),other=new (w.db.constructor)(w.file);try{
  let advanced;w.onGet=async()=>{other.prepare("UPDATE drive_formatting_operations SET state='uncertain' WHERE operation_id=?").run(key);advanced=snapshot(other);};
  w.db.pragma('query_only = ON');const r=await w.status({account,operationId:key});assert.equal(r.observation.kind,'changedDuringObservation');assert.equal(r.observation.attribution,'invalidated');assert.deepEqual(snapshot(w.db),advanced);
 }finally{other.close();await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
for(const lost of [false,true])test(`actual semantic runtime-v2 SDK same-subject other-thread observation lost=${lost}`,async()=>{
 const w=await nativeWorld({approval:false,lost});try{
  const original=parse(await w.run());assert.equal(original.submission,lost?'unknown':'acknowledged');assert.equal(original.claim,lost?'held':'released');w.calls=[];
  let denied=false;
  const status=install(w,async(url,init)=>{assert.equal(init.method,'GET');assert.equal(w.db.inTransaction,false);if(denied&&new URL(url).hostname==='docs.googleapis.com')return Response.json({secret:'PRIVATE_DENIED'},{status:403});return w.fetchImpl(url,init);});
  const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await status({account:owner.account,operationId:keys[0]});assert.equal(r.status,lost?'uncertain':'verified');assert.equal(r.submission,original.submission);assert.equal(r.claim,original.claim);assert.equal(r.legacyFacts.semantic.originThreadId,owner.threadId);assert.equal(r.observation.kind,'observed_matching');assert.equal(r.thisCall.providerMutationCount,0);if(lost){assert.equal(r.stages[0].acknowledgement,undefined);assert.equal(r.response,null);assert.equal(r.observation.savedRevisionMatch,false);}assert.deepEqual(snapshot(w.db),before);
  if(!lost){w.document.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content='Other\n';assert.equal((await status({account:owner.account,operationId:keys[0]})).observation.kind,'observed_mismatch');assert.deepEqual(snapshot(w.db),before);denied=true;const outerStart=w.outerCalls.length,worldStart=w.calls.length;const unavailable=await status({account:owner.account,operationId:keys[0]});assert.equal(w.outerCalls.length-outerStart,3,'outer includes shortcut denied Docs GET');assert.equal(w.calls.length-worldStart,2,'world counter omits that shortcut and is NOT the complete request count');assert.equal(unavailable.observation.kind,'unavailable');assert.equal(unavailable.stages[0].submission,'acknowledged');assert.deepEqual(snapshot(w.db),before);}
 }finally{await w.close();}
});
test('native missing-kind hash observation and copy metadata are not invented populate/create ACK',async()=>{
 const w=await legacy('format');try{
  const id='22222222-2222-4222-8222-222222222222',p={operationId:id,subject:record.subject,requestHash:'a'.repeat(64),documentId:'doc-a',destinationId:'root-concrete',titleHash:hash('Synthetic fixture only'),textHash:hash('Wordmark\n'),outcome:'verified',writeAttempted:false};
  // Explicit historical input, NOT claimed as a native producer/acknowledgement.
  w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(id,record.subject,JSON.stringify(p));const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await w.status({account,operationId:id});assert.equal(r.observation.kind,'observed_matching');assert.equal(r.legacyFacts.json.kind,undefined);assert.equal(r.legacyFacts.json.populateAcknowledged,undefined);assert.equal(r.stages,undefined);assert.deepEqual(snapshot(w.db),before);
  w.db.pragma('query_only = OFF');const cp={operationId:id,subject:record.subject,kind:'copy',requestHash:'b'.repeat(64),fileId:'doc-a',destinationId:'root-concrete',titleHash:hash('Synthetic fixture only'),mimeType:'application/vnd.google-apps.document',outcome:'uncertain',acknowledged:false};w.db.prepare('UPDATE docs_creations SET receipt=? WHERE operation_id=?').run(JSON.stringify(cp),id);
  w.override=async u=>u.pathname.includes('/drive/v3/files/')?Response.json({id:'doc-a',name:'Synthetic fixture only',mimeType:cp.mimeType,trashed:false,parents:['root-concrete'],appProperties:{paCopyCreation:id}}):null;w.calls=[];const cb=snapshot(w.db);w.db.pragma('query_only = ON');const c=await w.status({account,operationId:id});assert.equal(c.observation.kind,'observed_matching');assert.equal(c.legacyFacts.json.acknowledged,false);assert.equal(w.calls.length,2);assert.deepEqual(snapshot(w.db),cb);
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
for(const version of [1,2])test(`actual replacement/${version} runtime-v2 recovery retains own ACK and does not normalize stored rows`,async()=>{
 const v=version===2?weightVector('named',true):null,w=await textWorld('longer',{approval:false,...v?{document:v.before,after:v.after,wire:v.wire}:{}});
 try{
  const original=parse(await w.run());assert.equal(original.state,'verified');assert.equal(original.stage.stageId,version===2?'text-2':'text-1');w.calls=[];
  const status=install(w,async(url,init)=>{assert.equal(init.method,'GET');assert.equal(w.db.inTransaction,false);return w.fetchImpl(url,init);});
  const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await status({account:owner.account,recoveryHandle:catalogHandle('semantic',keys[0])});assert.equal(r.historicalEvidenceVersion,'semantic-execution-v2');assert.equal(r.observation.kind,'observed_matching');assert.equal(r.claim,'released');assert.equal(r.submission,'acknowledged');assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();}
});
test('real SDK/file DB discovers ambiguity/corrupt version before GET, exact handle and wrong-subject nondisclosure',async()=>{
 const w=await legacy('format');try{
  // Legitimate historical collision input across two pre-semantic namespaces.
  w.db.prepare('INSERT INTO docs_image_operations (operation_id,subject,document_id,state,receipt) VALUES (?,?,?,?,?)').run(key,record.subject,'doc-a','uncertain',JSON.stringify({operationId:key,subject:record.subject,documentId:'doc-a',version:99,state:'writing'}));
  await w.store.addAccount({subject:'other-subject',email:'other@example.test',refreshToken:'SECRET_OTHER',accessToken:'SECRET_OTHER_ACCESS',expiresAt:Date.now()+600000});
  const before=snapshot(w.db);w.db.pragma('query_only = ON');w.calls=[];const a=await w.status({account,operationId:key});assert.equal(a.status,'ambiguous');assert.equal(a.candidates.length,2);assert.ok(a.candidates.some(c=>c.status==='unsupported'));assert.equal(w.calls.length,0);
  const unknown=await w.status({account:'other@example.test',operationId:key});assert.equal(unknown.status,'unknown');assert.equal(w.calls.length,0);assert.doesNotMatch(JSON.stringify(unknown),/doc-a|requestHash/);
  const unsupported=await w.status({account,recoveryHandle:catalogHandle('docs_image_operations',key)});assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.observation.kind,'unsupported');assert.equal(w.calls.length,0);
  assert.equal((await w.status({account,operationId:key,receiptKind:'drive_formatting_operations'})).observation.kind,'observed_matching');assert.equal(w.calls.length,3);assert.deepEqual(snapshot(w.db),before);
  for(const input of [{account,operationId:key,planHash:'a'.repeat(64)},{account,operationId:key,recoveryHandle:catalogHandle('docs_image_operations',key)},{account,recoveryHandle:catalogHandle('docs_image_operations',key)+'='},{account,operationId:key,receiptKind:'fake-verifier'}])await assert.rejects(()=>w.status(input));
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
test('semantic retained evidence remains readable after ordinary pin expiry and file reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'readonly-semantic-reopen-')),dbPath=join(dir,'saved.db');let w=await nativeWorld({approval:false,dbPath});
 try{
  assert.equal(parse(await w.run()).state,'verified');const raw=structuredClone(w.document);await w.close();w=await nativeWorld({reopen:true,approval:false,dbPath,document:raw});w.now=999999999;
  const status=install(w,async(url,init)=>{assert.equal(init.method,'GET');assert.equal(w.db.inTransaction,false);return w.fetchImpl(url,init);});const before=snapshot(w.db);w.db.pragma('query_only = ON');const r=await status({account:owner.account,operationId:keys[0]});assert.equal(r.status,'verified');assert.equal(r.observation.kind,'observed_matching');assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();rmSync(dir,{recursive:true,force:true});}
});
test('fatal raw UTF8 recovery rejects invalid bytes that a replacement decoder would falsely match',async()=>{
 const w=await legacy('format',{title:'Word\uFFFDmark'});try{
  const before=snapshot(w.db);w.db.pragma('query_only = ON');assert.equal((await w.status({account,operationId:key})).observation.kind,'observed_matching');
  const bytes=Buffer.from(JSON.stringify(w.document)),at=bytes.indexOf(Buffer.from('\uFFFD'));assert.ok(at>=0);const invalid=Buffer.concat([bytes.subarray(0,at),Buffer.from([255]),bytes.subarray(at+3)]);assert.equal(JSON.parse(invalid.toString('utf8')).title,w.document.title,'replacement decoding would hide the invalid bytes');
  w.override=async u=>u.hostname==='docs.googleapis.com'?new Response(invalid):null;w.calls=[];const result=await w.status({account,operationId:key});assert.equal(result.observation.kind,'unavailable');assert.equal(w.calls.length,3);assert.ok(w.calls.every(c=>c.method==='GET'));assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
for(const kind of ['format','page','image'])test(`closed ${kind} stored expected shape rejects corruption before any identity/provider GET`,async()=>{
 const w=await legacy(kind);try{
  const table=kind==='image'?'docs_image_operations':'drive_formatting_operations',original=JSON.parse(w.db.prepare(`SELECT receipt FROM ${table} WHERE operation_id=?`).get(key).receipt);
  const variants=kind==='image'?[p=>{p.objectId='';},p=>{delete p.objectId;},p=>{p.appliedRevision=false;},p=>{p.beforeDocument={};p.before=hash(JSON.stringify(p.beforeDocument));},p=>{p.proposal.heightPt='36';},p=>{p.proposal.asset.width=0;},p=>{p.request.uri='http://example.test/logo.png';p.proposal.uri=p.request.uri;p.requestHash=hash(JSON.stringify(p.request));}]:[p=>{p.expected={};},p=>{p.pageOnly=kind!=='page';},p=>{p.request.ranges=[];delete p.request.page;p.requestHash=hash(JSON.stringify(p.request));}];
  for(const corrupt of variants){w.db.pragma('query_only = OFF');const p=structuredClone(original);corrupt(p);w.db.prepare(`UPDATE ${table} SET receipt=? WHERE operation_id=?`).run(JSON.stringify(p),key);const before=snapshot(w.db);w.db.pragma('query_only = ON');w.calls=[];const result=await w.status({account,operationId:key});assert.equal(result.observation.kind,'unsupported');assert.equal(result.status,'unsupported');assert.equal(w.calls.length,0);assert.deepEqual(snapshot(w.db),before);}
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
for(const sealed of [false,true])test(`actual semantic ${sealed?'seal-only v1':'draft v1'} metadata is validated locally without DSP upgrade or HTTP`,async()=>{
 const w=await nativeWorld({approval:false});try{
  if(sealed){const service=createBoldSealService({store:w.store,docs:w.adapter.semanticDocs,clock:()=>w.now});await service.sealBold(owner,w.input);}
  const status=install(w,async()=>{throw Error('Metadata-only must not make provider calls');});w.calls=[];const before=snapshot(w.db);w.db.pragma('query_only = ON');const result=await status({account:owner.account,operationId:keys[0]});assert.equal(result.status,sealed?'sealed':'draft');assert.equal(result.historicalEvidenceVersion,sealed?'semantic-seal-v1':'semantic-draft-v1');assert.equal(result.claim,sealed?'held':'none');assert.equal(result.observation.kind,'unsupported');assert.equal(result.stages,undefined);assert.equal(w.calls.length,0);assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();}
});
for(const corrupt of ['impossibleDraftState','missingDraftFields','executionDigest'])test(`real semantic producer corrupt history ${corrupt} stays unsupported even in ambiguity, zero HTTP`,async()=>{
 const w=await nativeWorld({approval:false});try{
  if(corrupt==='executionDigest'){assert.equal(parse(await w.run()).state,'verified');w.db.prepare('UPDATE docs_semantic_execution SET record_digest=? WHERE operation_id=?').run('a'.repeat(64),keys[0]);}
  else {const p=JSON.parse(w.db.prepare('SELECT receipt FROM docs_semantic_drafts WHERE operation_id=?').get(keys[0]).receipt);if(corrupt==='impossibleDraftState')p.state='verified';else delete p.requestHash;w.db.prepare('UPDATE docs_semantic_drafts SET receipt=?,digest=? WHERE operation_id=?').run(JSON.stringify(p),draftHash(p),keys[0]);}
  w.calls=[];const status=install(w,async()=>{throw Error('No HTTP for corrupt local evidence');}),before=snapshot(w.db);w.db.pragma('query_only = ON');const single=await status({account:owner.account,operationId:keys[0]});assert.equal(single.status,'unsupported');assert.equal(single.observation.kind,'unsupported');assert.equal(w.calls.length,0);
  const local=createRecoveryReadStore(w.db,noWrites(w.store,w.forbidden));
  // Technical retained-history input adds an old-namespace collision; it is NOT
  // claimed as a native operation admitted around current global key guards.
  const history={namespace:'drive_formatting_operations',operationId:keys[0],subject:owner.subject,state:'uncertain',resource:'draft-doc',receipt:JSON.stringify({operationId:keys[0],subject:owner.subject,documentId:'draft-doc',state:'writing'}),writer:null,execution:null};
  const service=createRecoveryService({store:{...local,discover:(subject,id)=>[...local.discover(subject,id),history]},reads:new Proxy({},{get:()=>()=>{throw Error('No verifier selected for ambiguity');}})});
  const ambiguous=await service.status({account:owner.account,operationId:keys[0]},{threadId:'other'});assert.equal(ambiguous.status,'ambiguous');assert.equal(ambiguous.candidates.length,2);const candidate=ambiguous.candidates.find(c=>c.receiptKind==='semantic');assert.equal(candidate.supported,false);assert.equal(candidate.status,'unsupported');assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();}
});
for(const [save,recorded,k4,acceptable] of [[undefined,'ABSENT','ABSENT',true],['ALL_SAVED','ALL_SAVED','ALL_SAVED',true],['NO_UPDATES_REQUESTED','NO_UPDATES_REQUESTED','NO_UPDATES_REQUESTED',true],['ALL_FAILED_UNKNOWN_REASON','ALL_FAILED_UNKNOWN_REASON','ALL_FAILED_UNKNOWN_REASON',false],['UNSPECIFIED','UNSPECIFIED','UNSPECIFIED',false],['PRIVATE_UNRECOGNIZED_SAVE','UNKNOWN','UNSPECIFIED',false]])test(`K4 actual SDK projects retained ACK/save ${recorded}: own r2 versus identical body at r3`,async()=>{
 const w=await nativeWorld({approval:false,save});try{
  const original=parse(await w.run());assert.equal(original.submission,'acknowledged');assert.equal(original.state,acceptable?'verified':'uncertain');
  const literalReply={documentId:'draft-doc',replies:[{}],writeControl:{requiredRevisionId:'r2'},...(save?{commentUpdateState:save}:{})},ack={documentId:'draft-doc',revisionId:'r2',replyDigest:draftHash(literalReply)};
  const expectedResponse={kind:'acknowledged',...ack,save:recorded,saveAcceptable:acceptable,unexpectedSuggestions:false,unexpectedReply:false,unexpectedControl:false};
  const status=install(w,(url,init)=>w.fetchImpl(url,init)),before=snapshot(w.db);w.db.pragma('query_only = ON');
  for(const revision of ['r2','independent-r3']){
   w.document.revisionId=revision;const result=await status({account:owner.account,operationId:keys[0]});assert.equal(result.status,original.state);assert.equal(result.claim,original.claim);assert.equal(result.stages[0].submission,'acknowledged');assert.equal(result.stages[0].verification,original.stage.verification);assert.equal(result.stages[0].dispatchObserved,true);assert.deepEqual(result.stages[0].acknowledgement,ack);assert.equal(result.stages[0].collaborationSave,k4);assert.deepEqual(result.response,expectedResponse);assert.equal(result.observation.kind,'observed_matching');assert.equal(result.observation.savedRevisionMatch,revision==='r2');assert.equal(result.thisCall.providerMutationCount,0);assert.deepEqual(snapshot(w.db),before);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UNRECOGNIZED_SAVE/);
  }
 }finally{await w.close();}
});
for(const reject of [400,403])test(`K4 actual rejected ${reject} retains attributable rejection details, never an ACK`,async()=>{
 const w=await nativeWorld({approval:false,reject});try{
  const original=parse(await w.run());assert.equal(original.state,'rejected');const status=install(w,(url,init)=>new URL(url).hostname==='docs.googleapis.com'?Response.json(w.document):w.fetchImpl(url,init)),before=snapshot(w.db);w.db.pragma('query_only = ON');const result=await status({account:owner.account,operationId:keys[0]});assert.equal(result.status,'rejected');assert.equal(result.claim,'released');assert.equal(result.stages[0].submission,'rejected');assert.equal(result.stages[0].dispatchObserved,true);assert.deepEqual(result.stages[0].rejection,{httpStatus:reject,category:'provider_rejected'});assert.deepEqual(result.response,{kind:'rejected',httpStatus:reject});assert.equal(result.observation.kind,'observed_mismatch');assert.equal(result.stages[0].acknowledgement,undefined);assert.equal(result.stages[0].collaborationSave,undefined);assert.equal(result.observation.savedRevisionMatch,false);assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();}
});
test('K4 an unattributable stored reply/current match cannot supply an ACK or own revision',async()=>{
 const w=await nativeWorld({approval:false,malformed:true});try{
  const original=parse(await w.run());assert.equal(original.submission,'unknown');const saved=w.store.semanticExecutions.byId(owner,keys[0]);assert.ok(saved.record.reply,'unattributable raw reply was durably retained');assert.equal(saved.record.response,null);
  const status=install(w,(url,init)=>w.fetchImpl(url,init)),before=snapshot(w.db);w.db.pragma('query_only = ON');const result=await status({account:owner.account,operationId:keys[0]});assert.equal(result.submission,'unknown');assert.equal(result.claim,'held');assert.equal(result.response,null);assert.equal(result.stages[0].acknowledgement,undefined);assert.equal(result.stages[0].dispatchObserved,undefined);assert.equal(result.observation.kind,'observed_matching');assert.equal(result.observation.savedRevisionMatch,false);assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();}
});
test('positive copy discriminators cannot fall back through missing/wrong kind into document recovery',async()=>{
 const w=await legacy('format');try{
  const id='55555555-5555-4555-8555-555555555555',base={operationId:id,subject:record.subject,requestHash:'a'.repeat(64),outcome:'uncertain',documentId:'doc-a',destinationId:'root-concrete',titleHash:hash('Synthetic fixture only'),textHash:hash('Wordmark\n'),writeAttempted:false};
  // Retained historical INPUT only, not claimed as a native creation/ACK.
  w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(id,record.subject,JSON.stringify(base));
  for(const kind of [undefined,'document','spreadsheet','upload','copy'])for(const marker of [{copyBindingVersion:999},{copyBindingVersion:null},{copySource:{}},{copySource:null},{copyBindingVersion:1,copySource:{}}]){
   w.db.pragma('query_only = OFF');const input={...base,...kind?{kind}:{},...marker};w.db.prepare('UPDATE docs_creations SET receipt=? WHERE operation_id=?').run(JSON.stringify(input),id);const before=snapshot(w.db),start=w.outerCalls.length;w.db.pragma('query_only = ON');const result=await w.status({account,operationId:id});assert.equal(result.status,'unsupported');assert.equal(result.observation.kind,'unsupported');assert.equal(w.outerCalls.length,start,'positive discriminator fails locally BEFORE identity GET');assert.deepEqual(snapshot(w.db),before);
  }
  w.db.pragma('query_only = OFF');w.db.prepare('UPDATE docs_creations SET receipt=? WHERE operation_id=?').run(JSON.stringify(base),id);let before=snapshot(w.db),start=w.outerCalls.length;w.db.pragma('query_only = ON');const genuineOld=await w.status({account,operationId:id});assert.equal(genuineOld.observation.kind,'observed_matching');assert.equal(genuineOld.legacyFacts.json.kind,undefined);assert.equal(genuineOld.legacyFacts.json.createAcknowledged,undefined);assert.equal(genuineOld.legacyFacts.json.populateAcknowledged,undefined);assert.equal(w.outerCalls.length-start,3);assert.deepEqual(snapshot(w.db),before);
  const copy={...base,kind:'copy',fileId:'doc-a',sourceId:'source-a',mimeType:'application/vnd.google-apps.document',copyBindingVersion:1,copySource:{id:'source-a',mimeType:'application/vnd.google-apps.document',trashed:false,canCopy:true},acknowledged:false};
  w.db.pragma('query_only = OFF');w.db.prepare('UPDATE docs_creations SET receipt=? WHERE operation_id=?').run(JSON.stringify(copy),id);w.override=async u=>u.pathname.includes('/drive/v3/files/')?Response.json({id:'doc-a',name:'Synthetic fixture only',mimeType:copy.mimeType,trashed:false,parents:['root-concrete'],appProperties:{paCopyCreation:id}}):null;before=snapshot(w.db);start=w.outerCalls.length;w.db.pragma('query_only = ON');const bound=await w.status({account,operationId:id});assert.equal(bound.observation.kind,'observed_matching');assert.equal(bound.legacyFacts.json.copyBindingVersion,1);assert.equal(bound.legacyFacts.json.acknowledged,false);assert.equal(bound.stages,undefined);assert.equal(w.outerCalls.length-start,2);assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
test('outer request measurement includes shortcut 403 and SQL exec/pragma traps count caught attempts',async()=>{
 const w=await legacy('format');try{
  w.db.pragma('query_only = ON');const before=snapshot(w.db);w.statusReading=true;
  try{assert.throws(()=>{try{w.db.exec('UPDATE drive_accounts SET expires_at=0');}catch(e){assert.match(e.message,/FORBIDDEN SQL exec/);throw e;}},/FORBIDDEN SQL exec/);assert.throws(()=>w.db.pragma('query_only = OFF'),/FORBIDDEN SQL pragma/);}finally{w.statusReading=false;}
  assert.deepEqual(w.forbidden,['SQL exec','SQL pragma']);assert.equal(w.db.pragma('query_only',{simple:true}),1);assert.deepEqual(snapshot(w.db),before);trapCalibrations.push({technicalOnly:true,blockedExec:true,blockedPragma:true,caughtAttempts:w.forbidden.length,allRowsEqual:true});w.forbidden.length=0;
  w.override=async u=>u.hostname==='docs.googleapis.com'?Response.json({secret:'PRIVATE_DENIED'},{status:403}):null;const outerStart=w.outerCalls.length;assert.equal((await w.status({account,operationId:key})).observation.kind,'unavailable');assert.equal(w.outerCalls.length-outerStart,3);assert.ok(w.outerCalls.slice(outerStart).every(c=>c.inTransaction===false&&c.method==='GET'));assert.deepEqual(snapshot(w.db),before);
 }finally{await w.close();rmSync(w.dir,{recursive:true,force:true});}
});
