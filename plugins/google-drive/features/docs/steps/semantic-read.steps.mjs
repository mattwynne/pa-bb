import assert from 'node:assert/strict';
import {Given,When,Then,After} from '@cucumber/cucumber';
import {SemanticWorld,semanticAccount,semanticScope,semanticVector} from '../support/semantic-world.mjs';
import {checkFoundation} from '../support/foundation-checks.mjs';
import {paginationResidual,extentResidual} from '../support/residual-checks.mjs';
import {structuralBoundary,terminalBoundary} from '../support/boundary-checks.mjs';
When('the offline native boundary regression {string} runs',async function(kind){
  if(kind==='terminal')await terminalBoundary();else await structuralBoundary(kind);
  this.foundationCompleted=true;
});
When('the offline native residual regression {string} runs',async function(kind){
  if(kind==='completeEnvelope')await paginationResidual();else await extentResidual(kind);
  this.foundationCompleted=true;
});
When('the actual application foundation regression {string} runs',async function(kind){await checkFoundation(kind);this.foundationCompleted=true;});
Then('the foundation regression completed without live access',function(){assert.equal(this.foundationCompleted,true);});
Given('the offline semantic native host and independent rich document',async function(){this.semantic=new SemanticWorld();await this.semantic.init();});
After(async function(){await this.semantic?.close();});
When('the semantic projection {string} is requested',async function(kind){
  const w=this.semantic;
  if(kind==='deniedComments')w.fault=kind;
  if(kind==='nonEditor'){w.document=structuredClone(semanticVector.document);delete w.document.revisionId;}
  if(kind==='markdownKind'||kind==='wordKind')w.metadata={...semanticVector.metadata,mimeType:kind==='wordKind'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/markdown'};
  w.inspected=await w.inspect();
  if(['markdownKind','wordKind'].includes(kind))return;
  if(!['deniedComments','nonEditor'].includes(kind))w.assertInitialWire();
  if(kind==='wrongSubject')w.identity='subject-other';
  if(kind==='snapshotExpiry')w.clock=600000;
  const snapshotId=w.inspected.snapshotId;
  if(['crossRun','chipBoundary'].includes(kind))w.output=await w.call('docs_find',{account:semanticAccount,snapshotId,scope:semanticScope,query:{literal:kind==='crossRun'?'Old terms':'ABC'}});
  else w.output=await w.call('docs_read',{account:semanticAccount,snapshotId,scope:['header','footer','footnote'].includes(kind)?{tabs:{ids:['tab-a']},segments:[{kind}]}:semanticScope,
    format:kind==='text'||['header','footer','footnote'].includes(kind)?'text':'structured',styles:true,review:true},kind==='wrongThread'?'other-thread':'thread-a');
});
Then('the independent semantic expectation for {string} matches',function(kind){
  const w=this.semantic,r=w.output;
  if(['markdownKind','wordKind'].includes(kind)){assert.equal(w.inspected.kind,kind==='wordKind'?'wordBlob':'markdownBlob');assert.equal(w.inspected.snapshotId,null);assert.equal(w.inspected.content,'codecNotImplemented');return;}
  if(['wrongSubject','wrongThread','snapshotExpiry'].includes(kind)){assert.equal(r.outcome,'unavailable');assert.equal(w.last.result.isError,true);return;}
  if(['crossRun','chipBoundary'].includes(kind)){assert.equal(r.count,kind==='crossRun'?1:0);if(r.count)assert.deepEqual(r.candidates[0].extent,{start:7,end:16});assert.equal(r.readProof,false);return;}
  assert.equal(r.coverage.editReady,false);assert.equal(r.complete,true);
  if(kind==='text')assert.equal(r.records.map(x=>x.text).join(''),semanticVector.expected.bodyText);
  if(['header','footer','footnote'].includes(kind))assert.equal(r.records.map(x=>x.text).join(''),{header:'Header\n',footer:'Footer\n',footnote:'Note\n'}[kind]);
  if(kind==='structured')assert.equal(r.records.filter(x=>x.kind==='table').length,2);
  if(kind==='opaque')assert.deepEqual(r.records.find(x=>x.kind==='opaque').providerEvidence.futureBlock,{private:'opaque-evidence',nested:{flag:true}});
  if(kind==='unknownDefaults'){const n=r.records.find(x=>x.text==='Old ');assert.equal(n.style.absent,'unknown');assert.equal(n.style.properties.fontSize.provenance,'named');assert.equal(n.style.properties.underline,undefined);}
  if(kind==='deniedComments'){assert.equal(r.coverage.missingReviewCoverage,true);assert.ok(r.coverage.missingAspects.includes('review'));assert.equal(w.calls.filter(c=>c.url.startsWith('https://docs.googleapis.com')).length,2);}
  if(kind==='nonEditor')assert.deepEqual(r.revision,{kind:'unavailable',reason:'notProvided'});
});
Then('semantic reads sent zero provider mutations',function(){assert.ok(this.semantic.calls.every(c=>c.method==='GET'));});
When('semantic inspection encounters {string}',async function(fault){this.semantic.fault=fault;this.semantic.failed=await this.semantic.inspect(fault==='wrongView'?{view:'acceptedPreview'}:{});});
Then('semantic inspection fails safely without provider mutation',function(){const w=this.semantic;assert.equal(w.last.result.isError,true);assert.equal(w.failed.outcome,'unavailable');
  const logs=w.host.harness.logEntries;assert.equal(logs.length,1);assert.doesNotMatch(JSON.stringify([w.failed,logs]),/PRIVATE_|writer@example|opaque-evidence/);assert.ok(w.calls.every(c=>c.method==='GET'));
});
