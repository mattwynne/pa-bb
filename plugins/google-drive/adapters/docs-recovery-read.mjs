// Fixed GET-only technical transport. No ordinary access()/refresh-capable port.
import {readSemanticJson} from './docs-semantic.mjs';
export function createRecoveryReadTransport({fetchImpl=fetch}){
 async function get(token,url,limit,signal){
  const response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(response.redirected){await response.body?.cancel().catch(()=>{});throw new Error('Recovery GET unavailable');}
  return (await readSemanticJson(response,limit)).document;
 }
 return Object.freeze({
  identity:(token,signal)=>get(token,'https://openidconnect.googleapis.com/v1/userinfo',65536,signal),
  metadata:(token,id,signal)=>get(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,trashed,driveId,parents,appProperties`,65536,signal),
  document:(token,id,signal)=>get(token,`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}?includeTabsContent=true`,1048576,signal)
 });
}
