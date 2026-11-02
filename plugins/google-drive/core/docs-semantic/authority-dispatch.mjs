// Locally OBSERVED generations, never remote-atomic authorization or getSync.
import {demand} from './draft-policy.mjs';
export function createAuthorityDispatch({bb,settings,store}){
 let epoch=0,disposed=false,policy=null;
 settings.onChange(next=>{epoch++;policy=next.requireDocsApproval!==false;});
 const stop=store.observeAccountMutations(()=>{epoch++;});
 const dispose=()=>{if(!disposed){epoch++;disposed=true;stop();}};
 bb.onDispose(dispose);
 const capture=()=>({epoch,disposed});
 function check(token){demand(!disposed&&token.epoch===epoch&&!token.disposed,'owner');}
 return Object.freeze({capture,check,dispose,disposed:()=>disposed,async readPolicy(){const token=capture();const values=await settings.get();check(token);policy=values.requireDocsApproval!==false;return policy;},currentPolicy:()=>policy});
}
