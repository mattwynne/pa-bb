// A retained point-in-time copy input, not frozen content, ancestry closure or
// provider authority. Historical receipts are never filled from caller inputs.
import {digest} from './docs-semantic/common.mjs';
const id=x=>typeof x==='string'&&/^[\w-]{1,256}$/.test(x)&&x!=='root';
const text=x=>typeof x==='string'&&x.trim().length>0&&x.length<=255&&x.isWellFormed();
const check=c=>{if(!c)throw Object.assign(new Error('Copy source binding is unsupported.'),{writerCode:'unsupported',copyCode:'source'});};
export function inspectedCopySource(source,requestedId,useSourceName){
 check(source&&source.id===requestedId&&id(source.id)&&text(source.mimeType)&&source.trashed===false&&source.capabilities?.canCopy===true);
 if(useSourceName)check(text(source.name));
 return Object.freeze({id:source.id,mimeType:source.mimeType,trashed:source.trashed,canCopy:source.capabilities.canCopy,...(useSourceName?{name:source.name}:{})});
}
export function readCopySourceBinding(op){
 if(!Object.hasOwn(op,'copyBindingVersion')&&!Object.hasOwn(op,'copySource'))return {kind:'historicalSourceUncertified'};
 const s=op.copySource;check(op.kind==='copy'&&op.copyBindingVersion===1&&s&&typeof s==='object'&&!Array.isArray(s));
 const required=['id','mimeType','trashed','canCopy'];check(required.every(k=>Object.hasOwn(s,k))&&Object.keys(s).every(k=>required.includes(k)||k==='name'));
 check(id(op.sourceId)&&s.id===op.sourceId&&id(op.destinationId)&&text(s.mimeType)&&s.mimeType===op.mimeType&&s.trashed===false&&s.canCopy===true);
 if(Object.hasOwn(s,'name'))check(text(s.name)&&digest(s.name)===op.titleHash);
 return {kind:'boundSource'};
}
