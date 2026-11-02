// Captured single native Docs batch, NOT legacy prepareWrite's async post.
import {DOCS_WRITE_SCOPES} from './docs.mjs';
import {boundedJson,rejection} from './docs-transport.mjs';
import {readSemanticJson} from './docs-semantic.mjs';
import {draftHash,demand} from '../core/docs-semantic/draft-policy.mjs';
import {digest} from '../core/docs-semantic/common.mjs';
import {STAGE_LIMITS} from '../core/docs-semantic/execution-policy.mjs';
export function createSemanticBatchAdapter({verifiedAccess,fetchImpl=fetch}){
 return {async prepare(record,documentId,compiled,signal,guard=()=>{}){
  demand(/^[\w-]{1,256}$/.test(documentId),'invalid');signal?.throwIfAborted();
  guard();const token=await verifiedAccess(record,guard);guard();signal?.throwIfAborted();
  const info=await fetchImpl('https://oauth2.googleapis.com/tokeninfo',{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({access_token:token}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  guard();if(!info.ok)throw rejection(info.status);
  const granted=new Set(String((await boundedJson(info,16384)).scope??'').split(/\s+/));guard();demand(DOCS_WRITE_SCOPES.some(scope=>granted.has(scope)),'owner');signal?.throwIfAborted();
  const body=JSON.stringify(compiled),url=`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,programHash=draftHash(compiled),wireHash=digest(body);
  let used=false;
  return Object.freeze({programHash,wireHash,dispatchOnce(){
   demand(!used,'conflict');used=true;
   // No await, reauth, callback or retry between this invocation and real fetch.
   const response=fetchImpl(url,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
   return Promise.resolve(response).then(async r=>{
    let value=null;
    if(r.ok){try{value=(await readSemanticJson(r,STAGE_LIMITS.replyBytes)).document;}catch{/* malformed/lost body is attributable only as an HTTP observation */}}
    else{try{value=await boundedJson(r,STAGE_LIMITS.replyBytes);}catch{/* status remains an actual response, never invented ACK */}}
    return {status:r.status,body:value};
   });
  }});
 }};
}
