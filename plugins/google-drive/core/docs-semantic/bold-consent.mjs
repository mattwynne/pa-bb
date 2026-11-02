// Exact existing renderer payload from actual sealed intent and full before.
import {bytes,demand,draftHash,immutable} from './draft-policy.mjs';
import {docsApprovalDecision} from '../docs-approval.mjs';
export function boldApprovalDecision(raw){
 if(raw?.outcome==='submitted'&&(!raw.value||typeof raw.value!=='object'||Array.isArray(raw.value)||Object.keys(raw.value).length!==1||!Object.hasOwn(raw.value,'approved')||typeof raw.value.approved!=='boolean'))return {outcome:'approval_unavailable'};
 return docsApprovalDecision(raw);
}
export function boldConsentPayload(saved,plan,before,deadline){
 const h=saved.header,p=plan.sourceEvidence.paragraph.paragraph;
 demand(Number.isSafeInteger(deadline)&&deadline>h.createdAt&&deadline<=h.deadline,'snapshot');
 const sealExpiry=new Date(h.deadline).toISOString(),cardExpiry=new Date(deadline).toISOString();
 const effective=plan.effect.dependencies.nodes.filter(n=>n.kind==='text').map(n=>({start:n.extent.start,end:n.extent.end,...n.properties.bold}));
 const payload={account:h.account,operationId:h.operationId,documentId:h.documentId,title:before.evidence.title??before.metadata.name??'',expectedRevisionId:h.initialRevision.id,
  selections:[{...plan.target.range,textStyle:{bold:plan.command.bold},paragraphs:[{text:plan.target.text,paragraphStyle:p.paragraphStyle??{},runs:p.elements.map(e=>({startIndex:e.startIndex,endIndex:e.endIndex,textStyle:e.textRun.textStyle??{}}))}]}],page:null,
  limits:`Only bold in this exact whole paragraph (including its terminating newline) changes. Effective BEFORE bold/provenance/source per run: ${JSON.stringify(effective)}. All other observed document fields must be preserved. One EDIT batch under the original required revision; no collaboration or notification effects are authorized. Immutable plan head (SHA-256): ${h.headHash}. Seal expiry (UTC): ${sealExpiry}. Effective card/consent expiry (UTC): ${cardExpiry}. API readback is not rendering proof.`};
 demand(bytes(payload)<=48000,'budget');return immutable({payload,payloadHash:draftHash(payload)});
}
