import test from 'node:test';
import assert from 'node:assert/strict';
import { withWitnessWorld } from '../features/docs/support/witness-c-checks.mjs';
import { documentVector,node,scope,paragraph,expectedTarget } from '../features/docs/support/witness-c-vectors.mjs';
import { compareReadEvidence } from '../core/docs-semantic/coverage.mjs';
test('C inspected paragraph insertion compares newline, inherited identity and exact induced extents without delivered prose',()=>{
  const document=documentVector(),tab=document.tabs[0].documentTab;
  tab.body.content=[paragraph(1,'Old\n',{bold:false},{namedStyleType:'NORMAL_TEXT'})];
  return withWitnessWorld(({snapshot:s,world})=>{
    const selector={node:node(s,2)},effect={kind:'insertText',at:'end',text:'X'},registry=`${s.binding.snapshotId}:registry:1`;
    const dependencies={nodes:[
      {node:node(s,2),kind:'paragraph',parent:node(s,1),extent:{start:1,end:5},properties:{},storedStyle:{namedStyleType:'NORMAL_TEXT'},terminatingNewline:null,list:null,positionedObjectIds:[],review:{},unknownFields:[]},
      {node:node(s,3),kind:'text',parent:node(s,2),extent:{start:1,end:5},properties:{},storedStyle:{bold:false},terminatingNewline:{start:4,end:5,text:'\n'},list:null,positionedObjectIds:[],review:{},unknownFields:[]}
    ],registryRecords:[
      {id:registry,kind:'namedStyle',category:'styles',providerId:'NORMAL_TEXT',value:{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false,italic:false}},scopeRelation:'referenced'},
      {id:`${s.binding.snapshotId}:reference:1`,kind:'registryReference',ownerNode:node(s,2),definitionKind:'namedStyle',providerId:'NORMAL_TEXT',targets:[registry],status:'resolved',dependencyOwner:null},
      {id:`${s.binding.snapshotId}:reference:2`,kind:'registryReference',ownerNode:node(s,3),definitionKind:'namedStyle',providerId:'NORMAL_TEXT',targets:[registry],status:'resolved',dependencyOwner:node(s,2)}
    ],registryLosses:[]};
    const request={scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[2]}),dependencies,effect,changes:[
      {kind:'insertText',node:node(s,2),index:4,text:'X',inheritFrom:node(s,3)},
      {kind:'extentShift',node:node(s,2),before:{start:1,end:5},after:{start:1,end:6}},
      {kind:'extentShift',node:node(s,3),before:{start:1,end:5},after:{start:1,end:6}}
    ]}};
    const result=compareReadEvidence(s,request);assert.equal(result.witnessSatisfied,true,JSON.stringify(result.missingAspects));
    assert.equal(result.delivered,'effectPreview');assert.equal(result.editReady,false);
    assert.equal(world.observe().deliveries,0);
    request.presentation.changes.pop();assert.ok(compareReadEvidence(s,request).missingAspects.includes('effectPresentation'));
  },{document});
});
