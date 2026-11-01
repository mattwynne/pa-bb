// Original inert input/control matrix, not an execution-result generator.
// No production imports. Only writes the two JSON vectors beside this file.
// Control arguments are authored here; rejection expectations live in the
// parent comparator and never come from a native parse or an actual run.
import { writeFileSync } from 'node:fs';
const scope={tabs:{ids:['tab-e']},segments:[{kind:'body'}]};
const entries=[
  {name:'docs_inspect',control:{account:'reader@example.test',document:'doc-e',scope}},
  {name:'docs_read',control:{account:'reader@example.test',snapshotId:'snap-e',scope,format:'structured'}},
  {name:'docs_find',control:{account:'reader@example.test',snapshotId:'snap-e',scope,query:{literal:'Needle'}}},
  {name:'docs_find',control:{account:'reader@example.test',snapshotId:'snap-e',scope,selector:{node:'snap-e:2'}}},
  {name:'docs_inspect',control:{account:'reader@example.test',snapshotId:'snap-e',cursor:'cursor-e'}},
  {name:'docs_read',control:{account:'reader@example.test',snapshotId:'snap-e',cursor:'cursor-e'}},
];
const outcomes={
  refused:['*','tabs.documentTab.body.content','revisionId','body.content','tabs(*)','body.content'],
  noMutation:['tabs(documentTab(body))','tabs(documentTab(namedRanges))','documentId,revisionId','tabs.documentTab','*','tabs.*'],
};
for(const [outcome,masks] of Object.entries(outcomes)){
  const caseId=`C006.refuseRawMask__capability.${outcome}`;
  const fixture={
    provenance:{source:'Approved C006/K10 exclusion; original explicit native input/control matrix in generate.mjs',authorship:'E independent synthetic fixture; no provider, parser or reference-code oracle'},
    caseId,provider:{},http:[],
    calls:entries.map(({name,control},i)=>({name,args:{...control,fields:masks[i]},threadId:'thread-d'})),
    expected:{controls:entries.map(e=>e.control)},
  };
  writeFileSync(new URL(`./${caseId}.json`,import.meta.url),JSON.stringify(fixture,null,2)+'\n');
}
