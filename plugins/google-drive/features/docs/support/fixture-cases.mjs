// Direct test inputs, not acceptance/exposure accounting. Case names select the
// existing independently authored vectors; no planned obligations are expanded.
import {readdirSync,readFileSync} from 'node:fs';
const operations={C003:'docs_read.segment',C004:'docs_inspect.outline',C005:'docs_read.projection',C006:'docs_read.structure',C007:'docs_read.richCell',C008:'docs_read.opaque',C010:'docs_read.view',C011:'docs_read.reviewView',C012:'docs_find.literal',C013:'docs_find.normalization',C015:'selector.cardinality',C016:'selector.section',C017:'selector.handle',C020:'selector.tab',C021:'coverage.witness'};
export function fixtureCase(caseId){
 const match=/^(C\d+)\.(.+)__(read|local)\.(\w+)$/.exec(caseId);
 if(!match||!operations[match[1]])throw Error('Unknown semantic test vector');
 const [,ledgerId,base,requestedMode,outcomeVariant]=match,operation=operations[ledgerId];
 return {caseId,ledgerId,base,requestedMode,outcomeVariant,operation,key:caseId};
}
export function fixtureCases(...directories){return directories.flatMap(directory=>readdirSync(new URL('../coverage/fixtures/'+directory+'/',import.meta.url)).filter(n=>n.endsWith('.json')).sort().map(name=>{
 const record=fixtureCase(name.slice(0,-5)),fixture=JSON.parse(readFileSync(new URL('../coverage/fixtures/'+directory+'/'+name,import.meta.url)));
 return {record,fixture};
}));}
