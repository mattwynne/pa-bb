// Independently authored inert provider observations and expected witness values.
// No production model, selector, projection, digest or effect builder imports.
export const scope={tabs:{ids:['tab-a']},segments:[{kind:'body'}]};
export const paragraph=(start,text,style={},paragraphStyle={})=>({startIndex:start,endIndex:start+text.length,
  paragraph:{paragraphStyle,elements:[{startIndex:start,endIndex:start+text.length,textRun:{content:text,textStyle:style}}]}});
export function documentVector() {
  return {documentId:'doc-a',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Main'},documentTab:{body:{content:[
      paragraph(1,'Terms\n',{}, {namedStyleType:'HEADING_1',headingId:'terms'}),
      paragraph(7,'Old 😀 terms\n',{bold:false},{namedStyleType:'NORMAL_TEXT'}),
      paragraph(20,'End\n',{}, {namedStyleType:'HEADING_1',headingId:'end'}),
      {startIndex:24,endIndex:26,paragraph:{paragraphStyle:{namedStyleType:'NORMAL_TEXT'},elements:[{startIndex:24,endIndex:25,inlineObjectElement:{inlineObjectId:'logo'}},{startIndex:25,endIndex:26,textRun:{content:'\n'}}]}}
    ]},namedStyles:{styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false,italic:false}},{namedStyleType:'HEADING_1',textStyle:{bold:true}}]},
    inlineObjects:{logo:{inlineObjectProperties:{embeddedObject:{imageProperties:{contentUri:'https://example.test/logo.png'}}}}}}}]};
}
export const node=(s,n)=>`${s.binding.snapshotId}:${n}`;
export function binding(s) {
  return {...Object.fromEntries(['snapshotId','subject','account','threadId','documentId','view','retrievedAt'].map(key=>[key,s.binding[key]])),
    source:s.binding.source??'current',evidenceDigest:s.evidenceDigest,revision:{kind:'docs',id:s.evidence.revisionId,subject:s.binding.subject}};
}
export function normalDependencies(s,ids,propertyName) {
  const styleProperty=propertyName?{[propertyName]:{value:propertyName==='bold'?false:null,provenance:propertyName==='bold'?'direct':'unknown',source:null,status:propertyName==='bold'?'observed':'unknown'}}:{};
  const nodes=ids.map(n=>({node:node(s,n),kind:n===4?'paragraph':'text',parent:node(s,n===4?1:4),extent:{start:7,end:20},
    properties:n===4&&propertyName?{[propertyName]:{value:null,provenance:'unknown',source:null,status:'unknown'}}:styleProperty,
    storedStyle:n===4?{namedStyleType:'NORMAL_TEXT'}:{bold:false},terminatingNewline:n===4?null:{start:19,end:20,text:'\n'},
    list:null,positionedObjectIds:[],review:{},unknownFields:[]}));
  const reg=id=>`${s.binding.snapshotId}:registry:${id}`,ref=id=>`${s.binding.snapshotId}:reference:${id}`;
  return {nodes,registryRecords:[
    {id:reg(1),kind:'namedStyle',category:'styles',providerId:'NORMAL_TEXT',value:{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false,italic:false}},scopeRelation:'referenced'},
    {id:ref(5),kind:'registryReference',ownerNode:node(s,4),definitionKind:'namedStyle',providerId:'NORMAL_TEXT',targets:[reg(1)],status:'resolved',dependencyOwner:null},
    {id:ref(6),kind:'registryReference',ownerNode:node(s,5),definitionKind:'namedStyle',providerId:'NORMAL_TEXT',targets:[reg(1)],status:'resolved',dependencyOwner:node(s,4)}
  ],registryLosses:[]};
}
export function expectedTarget(s,selector,{nodes=[4],matches=[],selectedMatches=[],count=1,section}={}) {
  const sourceMaps=matches.map(match=>{
    let offset=0;const boundaries=[{normalizedOffset:0,sourceOffset:match.extent.start}];
    for(const scalar of match.text){offset+=scalar.length;boundaries.push({normalizedOffset:offset,sourceOffset:match.extent.start+offset});}
    return {node:match.node,extent:match.extent,normalizedText:match.text,boundaries,runs:[{node:match.runs[0],extent:match.extent,text:match.text}]};
  });
  return {binding:binding(s),scope,selector,cardinality:selector.text?.cardinality??{exactly:1},status:'resolved',count,enumeration:'complete',
    nodes:nodes.map(n=>node(s,n)),matches,sourceMaps,selectedMatches,...section?{section}:{},materialized:'complete',delivered:'targetEvidence',witnessSatisfied:false,
    missingAspects:[],editReady:false,authoringAuthority:'notEstablished'};
}
export function styleRequest(s) {
  const selector={node:node(s,5)},effect={kind:'style',family:'text',set:{bold:true}};
  return {scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[5]}),dependencies:normalDependencies(s,[5,4],'bold'),
    changes:[{node:node(s,5),property:'bold',before:false,after:true,provenance:'direct',source:null}],effect}};
}
export function literalRequest(s) {
  const selector={text:{literal:'Old 😀',cardinality:{exactly:1}}},effect={kind:'replaceLiteral',replacement:'New 😀',stylePolicy:'preservePositions'};
  const match={snapshotId:s.binding.snapshotId,node:node(s,4),tabId:'tab-a',segment:{kind:'body'},extent:{start:7,end:13},text:'Old 😀',context:'Old 😀 terms\n',runs:[node(s,5)]};
  return {scope,selector,effect,presentation:{target:expectedTarget(s,selector,{matches:[match],selectedMatches:[match]}),dependencies:normalDependencies(s,[4,5]),
    changes:[{kind:'literalReplacement',node:node(s,4),extent:{start:7,end:13},before:'Old 😀',after:'New 😀',runs:[node(s,5)],stylePolicy:'preservePositions'}],effect}};
}
export function broadRequest(s) {
  const selector={section:{headingId:'terms',includeHeading:false}},effect={kind:'destructiveScope',action:'replace',replacement:[{kind:'paragraph',text:'New terms'}]};
  const original=paragraph(7,'Old 😀 terms\n',{bold:false},{namedStyleType:'NORMAL_TEXT'});
  const originals=[{node:node(s,4),providerEvidence:original},{node:node(s,5),providerEvidence:original.paragraph.elements[0]}];
  const dependencies=normalDependencies(s,[4,5]);
  dependencies.boundaries=[[2,3,'terms',1,7],[6,7,'end',20,24]].map(([p,t,id,start,end])=>({
    node:node(s,p),kind:'paragraph',extent:{start,end},style:{explicit:{namedStyleType:'HEADING_1',headingId:id},
      properties:{namedStyleType:{value:'HEADING_1',provenance:'direct'},headingId:{value:id,provenance:'direct'}}},
    list:null,review:{},terminator:{node:node(s,t),extent:{start:end-1,end},text:'\n'},unknownFields:[]}));
  return {scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[4,5],count:2,section:{heading:node(s,2),start:7,end:20,includeHeading:false}}),
    dependencies,changes:[
      {kind:'removeOriginal',node:node(s,4),sourceKind:'paragraph',extent:{start:7,end:20},removedStyle:{namedStyleType:'NORMAL_TEXT'},list:null,positionedObjectIds:[],review:{},unknownFields:[]},
      {kind:'removeOriginal',node:node(s,5),sourceKind:'text',extent:{start:7,end:20},removedStyle:{bold:false},list:null,positionedObjectIds:[],review:{},unknownFields:[]},
      {kind:'replacementFragment',blocks:[{kind:'paragraph',text:'New terms'}]}],effect},originalRecords:originals};
}
