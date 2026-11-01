// Real application/domain behaviour with external ports only substituted.
// No native schema/dispatch, HTTP encoding or persistence claims.
import assert from 'node:assert/strict';
import { createSemanticReadService } from '../../../core/docs-semantic/application.mjs';
import { describeSemanticFailure } from '../../../core/docs-semantic/failures.mjs';
import { digest, semanticError } from '../../../core/docs-semantic/common.mjs';
import { createMemorySnapshots } from './memory-snapshots.mjs';
import { semanticVector,semanticAccount,semanticScope } from './semantic-fixtures.mjs';
export { semanticVector,semanticAccount,semanticScope } from './semantic-fixtures.mjs';
export class ApplicationWorld {
  constructor(){this.calls=[];this.clock=0;this.identity='subject-a';this.fault='none';this.logs=[];this.accounts=new Map([[semanticAccount,{subject:'subject-a',email:semanticAccount}]]);}
  async init({snapshotIds,...options}={}) {
    const memory=createMemorySnapshots({ids:snapshotIds});this.observe=memory.observe;
    this.store={semanticSnapshots:memory.port,byEmail:async account=>this.accounts.get(account)};
    const docs={
      authority:async record=>{this.calls.push({operation:'authority'});if(record.subject!==this.identity)throw semanticError('snapshot');},
      metadata:async(record,id)=>{this.calls.push({operation:'metadata',id});return structuredClone(this.metadata??semanticVector.metadata);},
      read:async(record,id,view,signal,{includeReview})=>{
        this.calls.push({operation:'read',id,view,includeReview});signal?.throwIfAborted();
        if(this.fault==='providerDenied'||this.fault==='deniedComments'&&includeReview)throw Object.assign(semanticError('denied'),{status:403});
        if(this.fault==='transport')throw new Error('PRIVATE_MESSAGE');
        const document=structuredClone(this.document??semanticVector.document);
        return {document,responseDigest:digest(JSON.stringify(document)),responseBytes:Buffer.byteLength(JSON.stringify(document)),reviewIncluded:includeReview&&view==='inline'};
      },
    };
    this.service=createSemanticReadService({store:this.store,docs,clock:()=>this.clock,diagnose:(operation,error)=>this.logs.push({operation,category:error.semanticCode}),...options});
  }
  async call(name,args,threadId='thread-a',signal) {
    const method={docs_inspect:'inspect',docs_read:'read',docs_find:'find'}[name];assert.ok(method,'unsupported application operation');
    try{const value=await this.service[method](args,threadId,signal);this.last={result:{},value};return value;}
    catch(error){const value=describeSemanticFailure(error);this.logs.push({operation:name,category:value.category});this.last={result:{isError:true},value};return value;}
  }
  inspect(extra={}){return this.call('docs_inspect',{account:semanticAccount,document:'doc-a',scope:semanticScope,...extra});}
  assertInitialPorts(){assert.deepEqual(this.calls,[{operation:'authority'},{operation:'metadata',id:'doc-a'},{operation:'read',id:'doc-a',view:'inline',includeReview:true}]);}
  async close(){}
}
