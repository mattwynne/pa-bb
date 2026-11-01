import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../core/docs-semantic/model.mjs';
import { semanticAccount as account } from '../features/docs/support/semantic-world.mjs';
import { correctionOwner,correctionRead,correctionWorld } from '../features/docs/support/a-correction-checks.mjs';
// Concrete enum neighbors are schema facts, not derived from production helpers.
for(const [key,value,known] of [
  ['sectionType','CONTINUOUS',true],['sectionType','SECTION_TYPE_UNSPECIFIED',false],['sectionType','FUTURE_SECTION',false],
  ['columnSeparatorStyle','NONE',true],['columnSeparatorStyle','COLUMN_SEPARATOR_STYLE_UNSPECIFIED',false],['columnSeparatorStyle','FUTURE_SEPARATOR',false],
  ['contentDirection','LEFT_TO_RIGHT',true],['contentDirection','CONTENT_DIRECTION_UNSPECIFIED',false],['contentDirection','FUTURE_DIRECTION',false],
  ['columnProperties',[{width:{magnitude:72,unit:'PT'},paddingEnd:{magnitude:4,unit:'PT'}}],true],
  ['columnProperties',[{width:{magnitude:72,unit:'UNIT_UNSPECIFIED'},paddingEnd:{magnitude:4,unit:'PT'}}],false],
  ['columnProperties',[{width:{magnitude:72,unit:'PT'},paddingEnd:{magnitude:4,unit:'FUTURE_UNIT'}}],false],
  ['columnProperties',[{width:{magnitude:72},paddingEnd:{magnitude:4,unit:'PT'}}],false],
])test(`A4 section typed evidence ${key} ${JSON.stringify(value)}`,()=>correctionWorld(async w=>{
  w.document.tabs[0].documentTab.body.content.unshift({startIndex:0,endIndex:1,sectionBreak:{sectionStyle:{[key]:value}}});
  const original=structuredClone(w.document);
  const pure=materialize({document:w.document,metadata:{id:'doc-a'},binding:{snapshotId:'pure-layout',subject:'subject-a',account,threadId:'thread-a',documentId:'doc-a',view:'inline'},reviewIncluded:true});
  const snapshotId=(await w.inspect()).snapshotId,snapshot=w.store.semanticSnapshots.get(snapshotId,correctionOwner,0);
  assert.deepEqual(snapshot.evidence,original);
  const node=Object.values(snapshot.nodes).find(n=>n.kind==='sectionBreak');
  const result=await w.call('docs_read',correctionRead(snapshotId,{selector:{node:node.id}}));
  assert.equal(result.complete,true);assert.equal(result.coverage.editReady,false);
  const [receipt]=w.store.semanticSnapshots.deliveries(snapshotId,correctionOwner,0,[result.coverage.deliveryToken]);
  assert.deepEqual(receipt.nodes,[node.id]);assert.deepEqual(receipt.nodeAspects[node.id],['content','styles','review']);
  for(const n of [Object.values(pure.nodes).find(n=>n.kind==='sectionBreak'),result.records[0]]){
    const p=n.style.properties[key];assert.deepEqual(p.value,value);
    assert.equal(p.propertyEvidence.effectiveStatus,known?'observed':'partialOrUnknown');
    assert.equal(p.effective.status,known?'storedApiValue':'partialOrUnknown');
    assert.equal(n.style.rendering,'notVerified');
  }
}));
