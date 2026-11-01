import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withWitnessWorld } from '../features/docs/support/witness-c-checks.mjs';
import { paragraph,node,binding } from '../features/docs/support/witness-c-vectors.mjs';
import { inspectNamedStyleEvidence,compareNamedStyleEvidence } from '../core/docs-semantic/named-style-evidence.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function documentOf(content,styles) {
  return {documentId:'doc-a',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Owners'},documentTab:{body:{content},namedStyles:{styles}}}]};
}
test('C3 unrelated paragraph review does not veto a complete different named-style usage',()=>{
  const selected=paragraph(1,'One\n',{}, {namedStyleType:'HEADING_1'}),other=paragraph(5,'Two\n',{}, {namedStyleType:'TITLE'});
  other.paragraph.suggestedParagraphStyleChanges={pending:{paragraphStyle:{alignment:'CENTER'}}};
  const styles=[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false}},{namedStyleType:'HEADING_1',textStyle:{bold:true}},{namedStyleType:'TITLE',textStyle:{bold:true}}];
  return withWitnessWorld(({snapshot:s})=>{
    const query={tabId:'tab-a',namedType:'HEADING_1',family:'text',property:'bold',value:false},page=inspectNamedStyleEvidence(s,query);
    const reg=i=>`${s.binding.snapshotId}:registry:${i}`,ref=i=>`${s.binding.snapshotId}:reference:${i}`;
    const deps=[['HEADING_1',2],['NORMAL_TEXT',1]];
    const usages=[{node:node(s,3),kind:'text',tabId:'tab-a',segment:{kind:'body'},namedType:'HEADING_1',directOverride:null,
      before:true,after:false,affected:true,provenance:'named',source:'HEADING_1',inheritedSource:'HEADING_1',status:'observed',
      dependencies:deps.map(([providerId,id],i)=>({id:ref(i+3),providerId,targets:[reg(id)],status:'resolved',dependencyOwner:node(s,2),dependencyEvidenceDigest:hash(selected)})),
      inheritanceOwners:[{node:node(s,2),kind:'paragraph',evidenceDigest:hash(selected),namedStyleType:'HEADING_1',review:{},unknownFields:[],
        references:deps.map(([providerId,id],i)=>({id:ref(i+1),definitionKind:'namedStyle',providerId,targets:[reg(id)],status:'resolved',dependencyOwner:null,dependencyEvidenceDigest:null}))}],review:{},unknownFields:[]}];
    assert.deepEqual(page.usages,usages);
    const expected={binding:binding(s),request:query,definition:{id:reg(2),original:styles[1],property:'bold',before:true,after:false},usages,
      offset:0,total:1,nextOffset:null,witnessDigest:page.witnessDigest,complete:true,missingAspects:[],materialized:'complete',delivered:'propertyPage',witnessSatisfied:false,
      indirect:true,contentDeletion:false,editReady:false,authoringAuthority:'notEstablished'};
    assert.equal(compareNamedStyleEvidence(s,query,[expected]).witnessSatisfied,true);
  },{document:documentOf([selected,other],styles)});
});
for(const unknown of [false,true])test(`C3 table ancestor unknown=${unknown} remains separate from precise direct overrides`,()=>{
  const cell={startIndex:3,endIndex:9,content:[paragraph(4,'Cell\n',{bold:false},{namedStyleType:'NORMAL_TEXT'})]};
  if(unknown)cell.futureInheritanceRule={meaning:'not classified'};
  const table={startIndex:1,endIndex:10,table:{rows:1,columns:1,tableRows:[{startIndex:2,endIndex:10,tableCells:[cell]}]}};
  const styles=[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false}}];
  return withWitnessWorld(({snapshot:s})=>{
    const query={tabId:'tab-a',namedType:'NORMAL_TEXT',family:'text',property:'bold',value:true},page=inspectNamedStyleEvidence(s,query);
    assert.deepEqual(page.usages.map(u=>[u.node,u.before,u.after,u.affected,u.provenance,u.directOverride,u.status]),[[node(s,6),false,false,false,'direct',false,'observed']]);
    const owner=page.usages[0].inheritanceOwners.find(o=>o.kind==='tableCell');
    assert.deepEqual(owner,{node:node(s,4),kind:'tableCell',evidenceDigest:hash(cell),namedStyleType:null,review:{},
      unknownFields:unknown?[{path:['tabs',0,'documentTab','body','content',0,'table','tableRows',0,'tableCells',0],field:'futureInheritanceRule',digest:hash({meaning:'not classified'})}]:[],references:[]});
    const result=compareNamedStyleEvidence(s,query,[page]);assert.equal(result.witnessSatisfied,!unknown);
    if(unknown)assert.ok(result.missingAspects.includes('unknownDependentFields'));
  },{document:documentOf([table],styles)});
});
