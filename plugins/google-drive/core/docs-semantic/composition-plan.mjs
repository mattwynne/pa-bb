// Closed compact composition codec. Shared RAW witnesses, never hash-only authority.
import {assertLogicalPlan,logicalDigest,sameLogical} from './logical-plan.mjs';
import {boundedPlan,strict,demand,keyValid,hashValid,draftHash,immutable} from './draft-policy.mjs';
import {COMPOSITION_LIMITS,initialInput,familyInput,compositionCommand} from './composition-policy.mjs';
import {digest} from './common.mjs';
export function scalarParts(p){return p.parts.map(x=>{
 const source=x.source,entry=p.sourceEvidence[source.kind==='body'?'bodies':'paragraphs'][source.index],path=x.target.path;
 demand(entry&&sameLogical(entry.path,source.kind==='body'?path.slice(0,-2):path),'corrupt');
 const sourceEvidence=x.kind==='paragraphReplace'?{node:x.command.node,path,bodyPath:entry.path,body:entry.body,digest:digest(entry.body),namedStyles:entry.namedStyles}:{node:x.command.node,path,digest:digest(source.kind==='body'?entry.body.content[path.at(-1)]:entry.paragraph),paragraph:source.kind==='body'?entry.body.content[path.at(-1)]:entry.paragraph};
 const body={version:1,kind:x.kind,mode:'direct',capabilityVersion:x.capabilityVersion,lifecycle:p.lifecycle,binding:p.binding,command:x.command,sourceEvidence,target:x.target,effect:x.effect,verification:x.verification};return {...body,integrity:draftHash(body)};
 });}
export function assertCompositionPlan(p,{record,snapshot}={}){
 boundedPlan(p);strict(p,['version','kind','mode','capabilityVersion','lifecycle','binding','origin','extensions','sourceEvidence','parts','verification','integrity']);demand(p.version===1&&p.kind==='paragraphComposition'&&p.mode==='direct'&&p.capabilityVersion==='paragraph-composition/1','unsupported');const {integrity,...body}=p;demand(hashValid(integrity)&&logicalDigest(body)===integrity,'corrupt');
 strict(p.origin,['draftId','initial']);demand(keyValid(p.origin.draftId),'corrupt');initialInput(p.origin.initial);
 demand(Array.isArray(p.extensions)&&p.extensions.length<COMPOSITION_LIMITS.commands,'budget');for(const e of p.extensions){strict(e,['family','request']);familyInput(e.request,e.family);demand(e.request.draft.kind==='extend'&&e.request.draft.draftId===p.origin.draftId&&e.request.account===p.binding.account,'corrupt');}
 strict(p.sourceEvidence,['bodies','paragraphs']);for(const [key,fields]of [['bodies',['path','body','namedStyles']],['paragraphs',['path','paragraph']]]){demand(Array.isArray(p.sourceEvidence[key])&&p.sourceEvidence[key].length<=COMPOSITION_LIMITS.commands,'budget');for(const entry of p.sourceEvidence[key])strict(entry,fields);demand(new Set(p.sourceEvidence[key].map(e=>draftHash(e.path))).size===p.sourceEvidence[key].length,'corrupt');}
 demand(Array.isArray(p.parts)&&p.parts.length>0&&p.parts.length<=COMPOSITION_LIMITS.commands,'budget');const used=new Set(),nodes=new Set(),paths=new Set();
 for(const part of p.parts){strict(part,['kind','capabilityVersion','command','target','effect','verification','source','provenance']);compositionCommand(part.command);strict(part.source,['kind','index']);demand(['body','paragraph'].includes(part.source.kind)&&Number.isSafeInteger(part.source.index)&&part.source.index>=0&&part.source.index<COMPOSITION_LIMITS.commands&&(part.kind!=='paragraphReplace'||part.source.kind==='body'),'corrupt');used.add(`${part.source.kind}/${part.source.index}`);demand(!nodes.has(part.command.node)&&!paths.has(draftHash(part.target.path)),'conflict');nodes.add(part.command.node);paths.add(draftHash(part.target.path));
  demand(Array.isArray(part.provenance)&&part.provenance.length>0&&part.provenance.length<=COMPOSITION_LIMITS.ancestry,'budget');for(const v of part.provenance){strict(v,['kind','draftId','headHash','commandIndex','requestHash']);demand(['new','extend','combine','scalar'].includes(v.kind)&&keyValid(v.draftId)&&(v.headHash===null&&v.kind==='new'||hashValid(v.headHash))&&Number.isSafeInteger(v.commandIndex)&&v.commandIndex>=0&&v.commandIndex<COMPOSITION_LIMITS.commands&&hashValid(v.requestHash),'corrupt');}
 }
 for(const [key,kind]of [['bodies','body'],['paragraphs','paragraph']])for(const [i]of p.sourceEvidence[key].entries())demand(used.has(`${kind}/${i}`),'corrupt');
 const expanded=scalarParts(p);for(const scalar of expanded)assertLogicalPlan(scalar,{snapshot});
 demand(sameLogical(p.verification,{kind:'disjointParagraphsWholeDocument',version:1,schedule:'descendingWholeBlocksPerTab',normalization:'unionOfSelectedScalarContracts',cardBytes:COMPOSITION_LIMITS.cardBytes,commandLimit:COMPOSITION_LIMITS.commands}),'corrupt');
 const initial=p.origin.initial;
 if(initial.family!=='combine'){
  const batches=[{family:initial.family,request:initial.request},...p.extensions],expected=batches.flatMap(e=>familyInput(e.request,e.family));demand(sameLogical(p.parts.map(x=>x.command),expected),'corrupt');let index=0;
  for(const [batch,e]of batches.entries())for(const [i]of e.request.commands.entries()){const v={kind:batch===0?'new':'extend',draftId:p.origin.draftId,headHash:batch===0?null:e.request.draft.expectedDraftHash,commandIndex:i,requestHash:draftHash(e)};demand(sameLogical(p.parts[index++].provenance,[v]),'corrupt');}
 }
 if(record){const r=record.version===3?record.prior:record;demand(r.version===2&&r.profile==='paragraph-composition/1'&&p.origin.draftId===r.operationId&&draftHash(p.origin.initial)===r.requestHash&&sameLogical(p.origin.initial,r.initialInput),'corrupt');for(const k of ['subject','account','threadId','snapshotId'])demand(p.binding[k]===r[k],'corrupt');demand(p.lifecycle.createdAt===r.lifetimeAnchor&&p.lifecycle.expiresAt===r.expiresAt,'corrupt');}
 return p;
}
export function packComposition(scalars,{origin,extensions=[],provenance}){
 demand(scalars.length>0&&scalars.length<=COMPOSITION_LIMITS.commands,'budget');const bodies=[],paragraphs=[];
 for(const s of scalars.filter(x=>x.kind==='paragraphReplace'))if(!bodies.some(b=>sameLogical(b.path,s.sourceEvidence.bodyPath)))bodies.push({path:s.sourceEvidence.bodyPath,body:s.sourceEvidence.body,namedStyles:s.sourceEvidence.namedStyles});
 const parts=scalars.map((s,i)=>{const path=s.target.path,bodyIndex=bodies.findIndex(b=>sameLogical(b.path,path.slice(0,-2)));let source;if(bodyIndex>=0)source={kind:'body',index:bodyIndex};else{demand(s.kind==='paragraphBold','corrupt');source={kind:'paragraph',index:paragraphs.length};paragraphs.push({path,paragraph:s.sourceEvidence.paragraph});}return {kind:s.kind,capabilityVersion:s.capabilityVersion,command:s.command,target:s.target,effect:s.effect,verification:s.verification,source,provenance:provenance[i]};});
 const first=scalars[0],body={version:1,kind:'paragraphComposition',mode:'direct',capabilityVersion:'paragraph-composition/1',binding:first.binding,lifecycle:first.lifecycle,origin,extensions,sourceEvidence:{bodies,paragraphs},parts,verification:{kind:'disjointParagraphsWholeDocument',version:1,schedule:'descendingWholeBlocksPerTab',normalization:'unionOfSelectedScalarContracts',cardBytes:COMPOSITION_LIMITS.cardBytes,commandLimit:COMPOSITION_LIMITS.commands}};
 const plan=immutable({...body,integrity:draftHash(body)});assertCompositionPlan(plan);return plan;
}
export function compositionShape(plan){assertCompositionPlan(plan);return {commands:plan.parts.map(p=>p.kind==='paragraphBold'?{kind:'bold'}:{kind:'replace',deleteUnits:p.effect.changed.removed.length,insertUnits:p.effect.changed.inserted.length})};}
export function compositionReplies(shape){strict(shape,['commands']);demand(Array.isArray(shape.commands)&&shape.commands.length>0&&shape.commands.length<=COMPOSITION_LIMITS.commands,'corrupt');return shape.commands.reduce((n,c)=>{if(c.kind==='bold'){strict(c,['kind']);return n+1;}strict(c,['kind','deleteUnits','insertUnits']);demand(c.kind==='replace'&&[c.deleteUnits,c.insertUnits].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=2000)&&c.deleteUnits+c.insertUnits>0,'corrupt');return n+Number(c.deleteUnits>0)+2*Number(c.insertUnits>0);},0);}
