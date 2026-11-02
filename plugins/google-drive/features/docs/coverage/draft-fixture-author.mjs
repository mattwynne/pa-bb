// Original literal expectations. Never imports/executes production code or
// records its output as an oracle. This authoring script is not acceptance.
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const owner={subject:'evidence-subject',account:'writer@example.test',threadId:'evidence-thread'};
const binding={...owner,snapshotId:'evidence-snapshot',documentId:'evidence-doc',view:'inline',retrievedAt:0};
const document={documentId:'evidence-doc',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',futureUnknown:{retained:'opaque'},tabs:[{tabProperties:{tabId:'tab-a',title:'Main',index:0},documentTab:{body:{content:[{startIndex:1,endIndex:6,paragraph:{elements:[{startIndex:1,endIndex:4,textRun:{content:'A😀',textStyle:{bold:false,italic:true}}},{startIndex:4,endIndex:6,textRun:{content:'x\n',textStyle:{bold:false}}}]}},{startIndex:6,endIndex:11,paragraph:{elements:[{startIndex:6,endIndex:11,textRun:{content:'Keep\n',textStyle:{bold:false}}}]}}]}}}]};
const after={documentId:'evidence-doc',revisionId:'r2',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',futureUnknown:{retained:'opaque'},tabs:[{tabProperties:{tabId:'tab-a',title:'Main',index:0},documentTab:{body:{content:[{startIndex:1,endIndex:6,paragraph:{elements:[{startIndex:1,endIndex:4,textRun:{content:'A😀',textStyle:{bold:true,italic:true}}},{startIndex:4,endIndex:6,textRun:{content:'x\n',textStyle:{bold:true}}}]}},{startIndex:6,endIndex:11,paragraph:{elements:[{startIndex:6,endIndex:11,textRun:{content:'Keep\n',textStyle:{bold:false}}}]}}]}}}]};
const groups=[['C027','draft.composition',['sameRequestRecovery','cancelDraft','noDraftClaims']],['C190','journal.keys',['serverIssued','requestIdRecovery','identicalDuplicate','differentInputConflict','failedPlanningConsumed','cancelledTombstone','crossNamespaceCollision']],['C191','journal.claims',['draftNoClaim']],['C194','verifier.independence',['noCompilerOracle','exactFootprint','unknownFields']],['C203','budgets.lifecycle',['draftTtl']]];
// Each list is independently specified by the named behavior, not generated
// from the executor's observations. Tokens are comparator contracts, not passes.
const expected={
 sameRequestRecovery:[[['plan','draft'],['repeat','draft'],['status','draft']],[['plan','draft'],['changed','!request_conflict'],['status','draft']]],
 cancelDraft:[[['plan','draft'],['cancel','cancelled'],['status','cancelled']],[['plan','draft'],['foreignCancel','!owner'],['status','draft']]],
 noDraftClaims:[[['plan','draft'],['second','draft2'],['legacyFirst',true],['legacySecond',false]],[['legacyFirst',true],['plan','draft'],['cancel','cancelled'],['legacySecond',false]]],
 serverIssued:[[['plan','draft']],[['callerKey','!invalid'],['control','draft']]],
 requestIdRecovery:[[['planMissing','rejectedUnsupported'],['status','rejectedUnsupported']],[['plan','draft'],['foreignLookup','!unknown'],['status','draft']]],
 identicalDuplicate:[[['plan','draft'],['repeat','draft'],['status','draft']],[['plan','draft'],['duplicateReserve','duplicate'],['changedReserve','!request_conflict']]],
 differentInputConflict:[[['plan','draft'],['opposite','draft2False']],[['plan','draft'],['changed','!request_conflict'],['status','draft']]],
 failedPlanningConsumed:[[['planMissing','rejectedUnsupported'],['repeatMissing','rejectedUnsupported'],['status','rejectedUnsupported']],[['failedPublication','!storage'],['retained','planning'],['repeat','planning']]],
 cancelledTombstone:[[['plan','draft'],['cancel','cancelled'],['status','cancelled'],['repeat','cancelled']],[['plan','draft'],['cancel','cancelled'],['reuseKey','!key_conflict'],['status','cancelled']]],
 crossNamespaceCollision:[[['legacySeed','six'],['blocked','!key_conflict'],['control','draft2']],[['plan','draft'],['cancel','cancelled'],['legacyReservations','sixConflicts']]],
 draftNoClaim:[[['legacyFirst',true],['plan','draft'],['legacySecond',false],['status','draft']],[['plan','draft'],['legacyFirst',true],['cancel','cancelled'],['legacySecond',false]]],
 noCompilerOracle:[[['logical','plan'],['compiled','wire'],['verify','matched']],[['logical','plan'],['coherentBeforeLie','forgedPlan'],['compiledLie','wire'],['verifyLie','!corrupt']]],
 exactFootprint:[[['logical','plan'],['verify','matched']],[['logical','plan'],['italic','notMatched'],['sibling','notMatched'],['text','notMatched'],['topology','notMatched']]],
 unknownFields:[[['logical','plan'],['verify','matched']],[['logical','plan'],['opaqueChanged','notMatched'],['opaqueRemoved','notMatched'],['targetUnknown','!witness']]],
 draftTtl:[[['plan','draft'],['justBefore','publication'],['status','expiredDraft']],[['latePublication','expiredRejected'],['status','expiredRejected']]],
};
const index={},rows=[];mkdirSync(root+'features/docs/coverage/fixtures/s03-draft',{recursive:true});mkdirSync(root+'features/docs/draft',{recursive:true});
for(const [ledger,operation,bases]of groups)for(const base of bases)for(const [oi,outcome]of ['success','counterexample'].entries()){
 const caseId=`${ledger}.${base}__local.${outcome}`;
 const f={caseId,operation,base,outcome,requestedMode:'local',contract:'paragraphBold/1',provenance:{source:'Original literal UTF16, ownership, key, deadline and preservation contracts in draft-fixture-author.mjs; no production-output capture',authorship:'S03 no-write evidence original independent fixtures'},owner,binding,document,after,input:{requestId:'request-a',snapshotId:'evidence-snapshot',mode:'direct',command:{op:'paragraphBold',node:'evidence-snapshot:2',bold:true}},expected:{events:expected[base][oi],target:{node:'evidence-snapshot:2',path:['tabs',0,'documentTab','body','content',0],range:{tabId:'tab-a',startIndex:1,endIndex:6},text:'A😀x\n'},changes:[{node:'evidence-snapshot:3',property:'bold',before:false,after:true,provenance:'direct',source:null},{node:'evidence-snapshot:4',property:'bold',before:false,after:true,provenance:'direct',source:null}],wire:{writeControl:{requiredRevisionId:'r1',writeMode:'EDIT'},requests:[{updateTextStyle:{range:{tabId:'tab-a',startIndex:1,endIndex:6},textStyle:{bold:true},fields:'bold'}}]},deadline:1800001,legacyTables:['docs_creations','drive_sharing_operations','drive_formatting_operations','drive_sheets_edits','drive_filing_operations','docs_image_operations']}};
 const path=`features/docs/coverage/fixtures/s03-draft/${caseId}.json`,text=JSON.stringify(f,null,2)+'\n';writeFileSync(root+path,text);index[caseId]={caseId,path,sha256:createHash('sha256').update(text).digest('hex'),provenance:f.provenance};rows.push(`      | ${caseId} |`);
}
writeFileSync(root+'features/docs/coverage/draft-fixtures.json',JSON.stringify(index,null,2)+'\n');
// Canonical normal-profile fixtures after independent no-write evidence review.
// Preserve all existing descriptors/formatting, and never create private duplicate
// Examples. This author changes no delivery declarations or executor answers.
const canonicalPath=root+'features/docs/coverage/fixtures/index.json',text=readFileSync(canonicalPath,'utf8'),canonical=JSON.parse(text),missing=[];
for(const [id,entry]of Object.entries(index)){if(canonical[id]){if(JSON.stringify(canonical[id])!==JSON.stringify(entry))throw Error('Existing draft fixture descriptor differs');}else missing.push('  '+JSON.stringify(id)+':'+JSON.stringify(entry)+',');}
if(missing.length){if(!text.startsWith('{\n'))throw Error('Unexpected canonical index layout');writeFileSync(canonicalPath,'{\n'+missing.join('\n')+'\n'+text.slice(2));}
for(const [ledger,,bases]of groups){const feature=`@F_${ledger==='C027'?'COMPOSE':'EXEC'} @${ledger==='C027'?'S_ORDER':ledger==='C190'?'S_KEYS':ledger==='C191'?'S_CLAIMS':ledger==='C194'?'S_INDEPENDENCE':'S_BOUNDS'}\nFeature: ${ledger} internal no-write evidence\n  @bridgeExecution\n  Scenario Outline: Actual supported internal contract [<caseId>]\n    When the fixed no-write production evidence executes "<caseId>"\n    Examples:\n      | caseId |\n${rows.filter(r=>bases.some(b=>r.includes(ledger+'.'+b+'__'))).join('\n')}\n`;writeFileSync(root+`features/docs/draft/${ledger}.feature`,feature);}
console.log(`Authored ${Object.keys(index).length} independent normal-profile fixtures; delivery declarations unchanged.`);
