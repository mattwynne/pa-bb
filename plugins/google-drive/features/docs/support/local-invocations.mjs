// Fixed production-bound local capture, analogous to the native execute wrapper.
// Routes receive methods, never a callback/record constructor or writable log.
import { resolveSelector as productionSelector } from '../../../core/docs-semantic/selectors.mjs';
import { evaluateWitness as productionWitness } from '../../../core/docs-semantic/coverage.mjs';
import { createHash, randomUUID } from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const copy=value=>freeze(structuredClone(value));
export const modelBinding=snapshot=>({binding:structuredClone(snapshot.binding),revision:structuredClone(snapshot.revision),modelDigest:hash(snapshot)});
export function localInvocationBoundary(store) {
  const records=[];
  const get=store.semanticSnapshots.get.bind(store.semanticSnapshots);
  // Private capture; not exported and never supplied by a route.
  function observe(operation,args,model,invoke) {
    const entry={id:randomUUID(),sequence:records.length+1,operation,args:copy(args),model:model?copy(modelBinding(model)):null};
    try {const result=invoke();records.push(copy({...entry,result}));return result;}
    catch(error){records.push(copy({...entry,error:{category:typeof error.semanticCode==='string'?error.semanticCode:'unexpected'}}));throw error;}
  }
  return Object.freeze({
    resolveSelector(snapshot,scope,selector){return observe('resolveSelector',{scope,selector},snapshot,()=>productionSelector(snapshot,scope,selector));},
    evaluateWitness(snapshot,fp,options){return observe('coverage.evaluateWitness',{footprint:fp,options},snapshot,()=>productionWitness(snapshot,fp,options));},
    getSnapshot(snapshotId,owner,now){return observe('semanticSnapshots.get',{snapshotId,owner,now},null,()=>get(snapshotId,owner,now));},
    records(){return copy(records);},
  });
}
