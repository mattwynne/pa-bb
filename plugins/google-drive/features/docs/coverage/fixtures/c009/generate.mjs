// Independent inert C009 vectors. No production model/projector/selector/store
// imports and no execution outputs. The reused C witness vector is itself an
// independently authored expectation module, not a production effect builder.
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {documentVector,styleRequest} from '../../../support/witness-c-vectors.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const owner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'};
const baseScope={tabs:{ids:['tab-d']},segments:[{kind:'body'}]};
for(const variant of ['cursorExpiry','cursorReplay','draftPinnedEvidence','empty','overrun','partial','snapshotExpiry','wrongThread'])for(const outcome of ['success','counterexample']){
 const paged=['cursorExpiry','cursorReplay','partial'].includes(variant),pin=variant==='draftPinnedEvidence',empty=variant==='empty'&&outcome==='success';
 const texts=paged?['A'.repeat(1400),'B'.repeat(variant==='cursorReplay'&&outcome==='counterexample'?5000:1400)+'\n']:['Br','idge\n'];
 const scope=pin?{tabs:{ids:['tab-a']},segments:[{kind:'body'}]}:baseScope;
 const content=empty?[]:[{startIndex:1,endIndex:1+texts.join('').length,paragraph:{elements:texts.map((text,i)=>({startIndex:i?1+texts[0].length:1,endIndex:i?1+texts.join('').length:1+texts[0].length,textRun:{content:text}}))}}];
 const document=pin?documentVector():{documentId:'doc-d',title:'Independent C009',revisionId:'rev-d',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-d',title:'Main',index:0},documentTab:{body:{content}}}]};
 const metadata={id:document.documentId,name:'Independent C009',mimeType:'application/vnd.google-apps.document',version:'7',modifiedTime:'2026-01-01T00:00:00Z',trashed:false,capabilities:{canEdit:true}};
 const binding={snapshotId:'snap-d',...owner,documentId:document.documentId,view:'inline',retrievedAt:0};
 const fact=(n,kind,parent,start,end,text)=>({id:`snap-d:${n}`,kind,parent:parent?`snap-d:${parent}`:null,tabId:pin?'tab-a':'tab-d',segment:{kind:'body'},extent:start===null?null:{start,end},...text===undefined?{}:{text}});
 const nodes=pin?[fact(1,'segment',null,null,null),fact(2,'paragraph',1,1,7),fact(3,'text',2,1,7,'Terms\n'),fact(4,'paragraph',1,7,20),fact(5,'text',4,7,20,'Old 😀 terms\n'),fact(6,'paragraph',1,20,24),fact(7,'text',6,20,24,'End\n'),fact(8,'paragraph',1,24,26),fact(9,'inlineObjectElement',8,24,25),fact(10,'text',8,25,26,'\n')]:[fact(1,'segment',null,null,null),...empty?[]:[fact(2,'paragraph',1,1,1+texts.join('').length),fact(3,'text',2,1,1+texts[0].length,texts[0]),fact(4,'text',2,1+texts[0].length,1+texts.join('').length,texts[1])]];
 const records=nodes.filter(n=>n.kind==='text').map(n=>({kind:'text',node:n.id,text:n.text,extent:n.extent}));
 const fixture={provenance:{source:'Original inert C009 provider/typed-node/record/boundary vectors in generate.mjs; C style witness authored separately in witness-c-vectors.mjs',authorship:'Independent fixture expectations; no production implementation or observed execution oracle'},caseId:`C009.${variant}__local.${outcome}`,variant,outcome,pageBytes:paged?3000:65536,owner,scope,
  provider:{identity:{sub:owner.subject,email:owner.account,email_verified:true},metadata,document},
  inspect:{account:owner.account,document:document.documentId,scope},
  read:{account:owner.account,snapshotId:'snap-d',scope,format:pin?'structured':'text',...pin?{styles:true,review:true}:{}},
  expected:{binding,revision:{kind:'docs',id:document.revisionId,subject:owner.subject},nodes,records,losses:empty?[]:[{node:'snap-d:3',kind:'styleAnnotationOmitted'},{node:'snap-d:4',kind:'styleAnnotationOmitted'},{node:'snap-d:2',kind:'styleAnnotationOmitted'}],cursorExpires:300000,snapshotExpires:600000,pinExpires:900000},
 };
 if(variant==='overrun')fixture.wireBytes=8388608+(outcome==='counterexample'?1:0);
 if(pin)fixture.witness={snapshotId:'snap-d',...styleRequest({binding,evidence:document,evidenceDigest:hash(document)})};
 writeFileSync(new URL(`./${fixture.caseId}.json`,import.meta.url),JSON.stringify(fixture,null,2)+'\n');
}
