// Native read port only: exact full Docs GET, bounded metadata GET. This module
// cannot submit a batch, broaden a grant, fetch an asset or inspect write scope.
import { createHash } from 'node:crypto';
import { LIMITS, semanticError, requireValue } from '../core/docs-semantic/common.mjs';
const views={inline:'SUGGESTIONS_INLINE',acceptedPreview:'PREVIEW_SUGGESTIONS_ACCEPTED',rejectedPreview:'PREVIEW_WITHOUT_SUGGESTIONS'};
export async function readSemanticJson(response,maxBytes=LIMITS.providerBytes) {
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw Object.assign(semanticError(response.status===403?'denied':'unavailable'),{status:response.status});}
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel().catch(()=>{});throw semanticError('budget');}
  requireValue(response.body,'unavailable');const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;requireValue(size<=maxBytes,'budget');chunks.push(Buffer.from(value));}
    const bytes=Buffer.concat(chunks);let document;
    try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw semanticError('corrupt');}
    return {document,responseDigest:createHash('sha256').update(bytes).digest('hex'),responseBytes:size};
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createSemanticDocsAdapter({verifiedAccess,fetchImpl=fetch}) {
  async function get(record,url,signal,maxBytes) {
    const token=await verifiedAccess(record);signal?.throwIfAborted();
    const response=await fetchImpl(url,{headers:{authorization:`Bearer ${token}`},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    return readSemanticJson(response,maxBytes);
  }
  return {
    async authority(record){await verifiedAccess(record);return {subject:record.subject};},
    async metadata(record,id,signal){const url=new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
      url.searchParams.set('fields','id,name,mimeType,modifiedTime,version,trashed,capabilities(canEdit)');url.searchParams.set('supportsAllDrives','true');
      return (await get(record,url,signal,65536)).document;
    },
    async read(record,id,view,signal,{includeReview=view==='inline'}={}){requireValue(Object.hasOwn(views,view));
      const url=new URL(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`);
      url.searchParams.set('includeTabsContent','true');url.searchParams.set('suggestionsViewMode',views[view]);
      if(includeReview&&view==='inline')url.searchParams.set('commentsViewMode','COMMENTS_VIEW_MODE_INCLUDED');
      // One exact requested observation. Fallback/coverage policy is application-owned.
      return {...await get(record,url,signal,LIMITS.providerBytes),reviewIncluded:includeReview&&view==='inline'};
    },
  };
}
