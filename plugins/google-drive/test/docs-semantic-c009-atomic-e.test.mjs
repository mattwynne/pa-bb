// C009 prerequisite regression, NOT normal ledger execution or tranche credit.
// All pressure is real bounded read-evidence storage on official disposable SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createSemanticSnapshotStore } from '../adapters/docs-semantic-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { registerSemanticReadTools } from '../docs-semantic-registration.mjs';
import { LIMITS } from '../core/docs-semantic/common.mjs';
import { closeAmbientNetwork } from '../features/docs/support/offline-network.mjs';
const owner={subject:'subject-c009',account:'reader@example.test',threadId:'thread-c009'};
const scope={tabs:{ids:['tab-c009']},segments:[{kind:'body'}]};
const account=owner.account;
const metadata={id:'doc-c009',name:'C009 atomic continuation fixture',mimeType:'application/vnd.google-apps.document',capabilities:{canEdit:true}};
const content=[];let offset=1;
for(let i=0;i<14;i++){
  const text=`Heading ${i}: ${'x'.repeat(80)}\n`,end=offset+text.length;
  content.push({startIndex:offset,endIndex:end,paragraph:{paragraphStyle:{headingId:`h${i}`,namedStyleType:'HEADING_1'},elements:[{startIndex:offset,endIndex:end,textRun:{content:text}}]}});offset=end;
}
const document={documentId:'doc-c009',revisionId:'rev-c009',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-c009',title:'Main',index:0},documentTab:{body:{content}}}]};
async function fixture(tool,run){
 const host=createFakePluginHost({pluginId:'google-drive'}),restore=closeAmbientNetwork(),faults=[],requests=[];
 try{
  const db=host.bb.storage.database(),store=createBbStore(db,host.bb.storage.migrate);assert.notEqual(db.name,':memory:');
  let token=0,id=0,now=0;const poolBytes=131072;
  store.semanticSnapshots=createSemanticSnapshotStore(db,{ids:()=>`token-${++token}`,limits:{...LIMITS,poolBytes}});
  await store.addAccount({subject:owner.subject,email:account,refreshToken:'PRIVATE_REFRESH',accessToken:'PRIVATE_TOKEN',expiresAt:9000000});
  const adapter=createGoogleAdapter({store,clock:()=>now,getClient:async()=>{throw Error('unexpected refresh');},fetchImpl:async(url,init)=>{
    try{
      requests.push({url:String(url),method:init.method??'GET'});assert.equal(init.method??'GET','GET');assert.equal(init.body,undefined);assert.equal(init.headers.authorization,'Bearer PRIVATE_TOKEN');
      if(String(url)==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:owner.subject,email:account,email_verified:true});
      if(String(url)==='https://www.googleapis.com/drive/v3/files/doc-c009?fields=id%2Cname%2CmimeType%2CmodifiedTime%2Cversion%2Ctrashed%2Ccapabilities%28canEdit%29&supportsAllDrives=true')return Response.json(metadata);
      assert.equal(String(url),'https://docs.googleapis.com/v1/documents/doc-c009?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED');return Response.json(document);
    }catch(error){faults.push('closed HTTP contract');throw error;}
  }});
  registerSemanticReadTools(host.bb,store,adapter,{clock:()=>now,ids:()=>`snapshot-${++id}`,pageBytes:3000});
  const dispatch=host.harness.behavior.callAgentTool.bind(host.harness.behavior);
  const call=async(name,args)=>{const result=await dispatch(name,args,{threadId:owner.threadId});return {result,value:JSON.parse(result.content[0].text)};};
  const inspect=await call('docs_inspect',{account,document:'doc-c009',scope,...tool==='docs_inspect'?{include:['outline']}:{}});
  assert.ok(inspect.value.snapshotId,JSON.stringify(inspect));const snapshotId=inspect.value.snapshotId;
  const first=tool==='docs_inspect'?inspect:await call('docs_read',{account,snapshotId,scope,format:'structured'});
  assert.equal(first.result.isError,undefined);assert.equal(first.value.complete,false);assert.ok(first.value.nextCursor);
  assert.ok(first.value.records.length);assert.ok(Buffer.byteLength(JSON.stringify(first.value))<=3000);
  const s=store.semanticSnapshots;assert.deepEqual(s.get(snapshotId,owner,0).evidence,document);
  const facts=()=>Object.fromEntries(['cursors','delivery','pins','read_work','integrity'].map(table=>[table,db.prepare(`SELECT * FROM docs_semantic_${table} ORDER BY rowid`).all()]));
  await run({db,s,snapshotId,first:first.value,call,facts,poolBytes,setTime:t=>{assert.ok(Number.isSafeInteger(t)&&t>=now);now=t;}});
  assert.deepEqual(faults,[]);assert.ok(requests.every(r=>r.method==='GET'));assert.ok(!JSON.stringify(host.harness.logEntries).includes('PRIVATE_'));
 }finally{try{await host.harness.lifecycle.dispose();}finally{restore();}}
}
for(const tool of ['docs_read','docs_inspect'])test(`C009 ${tool} failed page capacity preserves continuation; later successful page consumes it once`,{timeout:30000},()=>fixture(tool,async({s,snapshotId,first,call,facts,poolBytes,setTime})=>{
 // Real pins provide explicitly releasable pressure; copied deliveries are exact
 // real stored records, not fabricated coverage or mutated internal SQL rows.
 const pins=[];for(let i=0;i<16;i++){const pin=`pressure-${i}`;s.pin(snapshotId,owner,pin,0,900000);pins.push(pin);}
 const [delivery]=s.deliveries(snapshotId,owner,0,[first.coverage.deliveryToken]);let filled=false;
 for(let i=0;i<100;i++)try{s.deliver(snapshotId,owner,delivery,0);}catch(error){assert.equal(error.semanticCode,'budget');filled=true;break;}
 assert.equal(filled,true,'bounded pressure must reach the real pool cap');assert.ok(s.stats().bytes<=poolBytes);
 // Use remaining sub-page capacity for real pin rows until the same pool cap.
 for(let i=16;i<32;i++)try{const pin=`pressure-${i}`;s.pin(snapshotId,owner,pin,0,900000);pins.push(pin);}catch(error){assert.equal(error.semanticCode,'budget');break;}
 const before=facts(),continued={account,snapshotId,cursor:first.nextCursor};setTime(1);
 const failed=await call(tool,continued);assert.equal(failed.result.isError,true);assert.equal(failed.value.category,'budget');
 const afterFailure=facts();
 const durablePage=f=>({cursors:f.cursors,delivery:f.delivery,pins:f.pins,integrity:f.integrity.filter(r=>r.kind!=='work')});
 assert.deepEqual(durablePage(afterFailure),durablePage(before),'failed page must preserve cursor and delivery transaction');
 assert.equal(before.cursors.find(c=>c.id===first.nextCursor).expires,300000);
 assert.ok(afterFailure.read_work.find(r=>r.id===delivery.readId).bytes>before.read_work.find(r=>r.id===delivery.readId).bytes,'failed traversal remains charged to cumulative work');
 for(const pin of pins)s.releasePin(snapshotId,owner,pin);
 setTime(299999); // Last valid millisecond of the ORIGINAL five-minute cursor.
 const succeeded=await call(tool,continued);assert.equal(succeeded.result.isError,undefined,JSON.stringify(succeeded));assert.ok(succeeded.value.records.length);
 const after=facts();assert.ok(!after.cursors.some(c=>c.id===first.nextCursor));
 assert.ok(after.delivery.some(d=>d.id===succeeded.value.coverage.deliveryToken));
 if(succeeded.value.nextCursor)assert.ok(after.cursors.some(c=>c.id===succeeded.value.nextCursor));
 const replay=await call(tool,continued);assert.equal(replay.result.isError,true);assert.equal(replay.value.category,'snapshot');assert.deepEqual(facts(),after);
}));
for(const fault of ['state','owner','snapshot','expired','collision','reuseCursor','reuseAsDelivery'])test(`C009 continuation commit ${fault} refusal cannot consume or publish`,()=>fixture('docs_read',async({s,snapshotId,first,call,facts})=>{
 const peek=s.peekCursor(first.nextCursor,owner,0,snapshotId),before=facts();
 assert.equal(peek.snapshot.binding.snapshotId,snapshotId);assert.deepEqual(facts(),before);
 const [delivery]=s.deliveries(snapshotId,owner,0,[first.coverage.deliveryToken]);
 const continuation={cursor:first.nextCursor,state:structuredClone(peek.state)};
 if(fault==='state')continuation.state.offset++;
 const inputOwner=fault==='owner'?{...owner,threadId:'wrong-thread'}:owner;
 const tokens={deliveryToken:fault==='collision'?first.coverage.deliveryToken:fault==='reuseAsDelivery'?first.nextCursor:'new-delivery',nextCursor:fault==='reuseCursor'?first.nextCursor:'new-cursor'};
 assert.throws(()=>s.commitPage(fault==='snapshot'?'missing-snapshot':snapshotId,inputOwner,delivery,peek.state,fault==='expired'?300000:0,tokens,continuation),
   error=>fault==='collision'?error.code==='SQLITE_CONSTRAINT_PRIMARYKEY':error.semanticCode===(['state','reuseCursor','reuseAsDelivery'].includes(fault)?'conflict':'snapshot'));
 assert.deepEqual(facts(),before,'refusal rolls back consumed cursor and any delivery/continuation writes');
 const next=await call('docs_read',{account,snapshotId,cursor:first.nextCursor});assert.equal(next.result.isError,undefined);
 assert.ok(!facts().cursors.some(c=>c.id===first.nextCursor));
}));
