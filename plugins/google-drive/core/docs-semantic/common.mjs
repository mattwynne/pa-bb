// Read-only semantic primitives. No host, storage or provider dependencies.
import { createHash } from 'node:crypto';
export const LIMITS = Object.freeze({ providerBytes:8*1048576, nodes:100000, depth:32, pageBytes:65536,
  poolBytes:32*1048576, modelBytes:32*1048576, topologySlots:100000, reviewComparisons:1000000, activePerOwner:4, cursorMs:300000, snapshotMs:600000, pinMs:1800000, matches:500 });
const codes = new Set(['invalid','budget','scalar','extent','scope','snapshot','conflict','unavailable','denied','corrupt','unsupported','cancelled']);
export function semanticError(code) { return Object.assign(new Error(`Docs semantic ${codes.has(code)?code:'unavailable'}`),{semanticCode:codes.has(code)?code:'unavailable'}); }
export function requireValue(condition, code='invalid') { if(!condition) throw semanticError(code); }
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function scalar(text) {
  requireValue(typeof text==='string','scalar');
  for(let i=0;i<text.length;i++) { const c=text.charCodeAt(i); if(c>=0xd800&&c<=0xdbff) {const d=text.charCodeAt(++i);requireValue(d>=0xdc00&&d<=0xdfff,'scalar');} else requireValue(c<0xdc00||c>0xdfff,'scalar'); }
  return text;
}
export function freeze(value) { if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);} return value; }
export function boundedTree(value, limits=LIMITS) {
  let nodes=0; const stack=[[value,0]];
  while(stack.length) { const [v,depth]=stack.pop();requireValue(++nodes<=limits.nodes&&depth<=limits.depth,'budget');
    if(typeof v==='string') scalar(v);
    else if(v&&typeof v==='object') {
      requireValue(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null,'invalid');
      if(Array.isArray(v))requireValue(v.length<=limits.nodes-nodes-stack.length,'budget');
      const keys=Object.keys(v);
      requireValue(keys.length<=limits.nodes-nodes-stack.length,'budget');
      if(Array.isArray(v))requireValue(keys.length===v.length,'invalid');
      for(const key of keys){scalar(key);stack.push([v[key],depth+1]);}
    }
    else requireValue(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v),'invalid');
  }
  jsonBytes(value,limits.providerBytes);
}
// Measure JSON without allocating its serialized copy. A caller may reuse a
// cache for immutable provider subtrees; repeated references still count each time.
export function jsonBytes(value,maximum=LIMITS.modelBytes,cache=new WeakMap()) {
  function stringBytes(text){
    scalar(text);
    let size=2+Buffer.byteLength(text);
    for(let i=0;i<text.length;i++){
      const c=text.charCodeAt(i);
      if(c===34||c===92)size++;
      else if(c<32)size+=[8,9,10,12,13].includes(c)?1:5;
    }
    return size;
  }
  function measure(v){
    let size;
    if(typeof v==='string')size=stringBytes(v);
    else if(v===null||v===undefined)size=4;
    else if(typeof v!=='object'){
      requireValue(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v),'invalid');
      size=String(v).length;
    }
    else if(cache.has(v))size=cache.get(v);
    else {
      size=2;let count=0;
      if(Array.isArray(v)){
        requireValue(v.length<=Math.floor(maximum/2),'budget');
        for(let i=0;i<v.length;i++){
          size+=(i?1:0)+measure(v[i]);requireValue(size<=maximum,'budget');
        }
      }else for(const key of Object.keys(v)){
        if(v[key]===undefined)continue;
        size+=(count++?1:0)+stringBytes(key)+1+measure(v[key]);
        requireValue(size<=maximum,'budget');
      }
      cache.set(v,size);
    }
    requireValue(size<=maximum,'budget');return size;
  }
  return measure(value);
}
export function evidenceAt(snapshot, path) { return path.reduce((v,k)=>v?.[k],snapshot.evidence); }
