// Independent raw-observation verifier. No planner, compiler, effect builder or simulation.
import {scalar} from '../common.mjs';
import {validatedReadModel} from '../selectors.mjs';
import {assertReplacementPlan} from '../replacement-plan.mjs';
import {sameLogical} from '../logical-plan.mjs';
import {demand} from '../draft-policy.mjs';
const at=(o,p)=>p.reduce((v,k)=>v?.[k],o);
const props=['bold','italic','underline','strikethrough','fontSize','weightedFontFamily','foregroundColor'];
const only=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>keys.includes(k));
// /2 only, recognized TextStyle property owner. Invalid presence is never omission.
function normalizeWeightStyle(style){const f=style?.weightedFontFamily;if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(k=>!['fontFamily','weight'].includes(k))||typeof f.fontFamily!=='string'||!f.fontFamily.trim()||f.fontFamily.length>100)return style;if(Object.hasOwn(f,'weight')&&(!Number.isInteger(f.weight)||f.weight<100||f.weight>900||f.weight%100!==0))return style;return {...style,weightedFontFamily:{...f,weight:Object.hasOwn(f,'weight')?f.weight:400}};}
function canonical(runs,start,end,v2=false){if(!Array.isArray(runs)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw Error('extent');let pos=start;const result=[];for(const r of runs){if(!only(r,['startIndex','endIndex','textRun'])||!only(r.textRun,['content','textStyle'])||typeof r.textRun.content!=='string'||!Number.isSafeInteger(r.startIndex)||!Number.isSafeInteger(r.endIndex)||r.startIndex!==pos||r.endIndex!==pos+r.textRun.content.length||!r.textRun.content.length)throw Error('shape');scalar(r.textRun.content);pos=r.endIndex;const rawStyle=r.textRun.textStyle??{},style=v2?normalizeWeightStyle(rawStyle):rawStyle;if(!style||typeof style!=='object'||Array.isArray(style))throw Error('style');const prev=result.at(-1);if(prev&&sameLogical(prev.style,style))prev.text+=r.textRun.content;else result.push({text:r.textRun.content,style});}if(pos!==end)throw Error('extent');return result;}
function joinPieces(pieces,v2=false){const out=[];for(const raw of pieces){const p=v2?{...raw,style:normalizeWeightStyle(raw.style)}:raw;if(!p.text)continue;const prev=out.at(-1);if(prev&&sameLogical(prev.style,p.style))prev.text+=p.text;else out.push(p);}return out;}
export function compareParagraphReplace({plan,before,after}){
 assertReplacementPlan(plan);const v2=plan.capabilityVersion==='paragraph-replace/2',s=validatedReadModel(before),c=plan.command,p=s.nodes[c.node];demand(s.evidence.documentId===s.binding.documentId&&s.metadata.id===s.binding.documentId,'corrupt');demand(p?.kind==='paragraph'&&p.segment.kind==='body','corrupt');const b=s.binding;
 demand(sameLogical(plan.binding,{subject:b.subject,account:b.account,threadId:b.threadId,snapshotId:b.snapshotId,documentId:b.documentId,view:b.view,retrievedAt:b.retrievedAt,...Object.hasOwn(b,'source')?{source:b.source}:{},revision:s.revision,evidenceDigest:s.evidenceDigest}),'corrupt');
 const path=p.evidence.path,bodyPath=path.slice(0,-2),index=path.at(-1),body=at(s.evidence,bodyPath),original=body.content[index],runs=original.paragraph.elements,text=runs.map(r=>r.textRun.content).join('');
 demand(sameLogical(plan.sourceEvidence.body,body)&&sameLogical(plan.sourceEvidence.path,path),'corrupt');let match=-1,count=0;for(let i=0;i<=text.length-c.oldText.length;i++)if(text.slice(i,i+c.oldText.length)===c.oldText){match=i;count++;}demand(count===1,'corrupt');
 // Derive minimal change again from command scalars, not plan.effect.
 const oldChars=[...c.oldText],newChars=[...c.newText];let prefix=0,suffix=0;for(;prefix<Math.min(oldChars.length,newChars.length)&&oldChars[prefix]===newChars[prefix];prefix++);for(;suffix<oldChars.length-prefix&&suffix<newChars.length-prefix&&oldChars[oldChars.length-1-suffix]===newChars[newChars.length-1-suffix];suffix++);
 const offset=oldChars.slice(0,prefix).join('').length,removed=oldChars.slice(prefix,oldChars.length-suffix).join(''),inserted=newChars.slice(prefix,newChars.length-suffix).join(''),start=original.startIndex+match+offset,end=start+removed.length,delta=c.newText.length-c.oldText.length;
 const selected=s.nodes[p.children[0]].style?.properties??{};if(v2)demand(props.every(k=>Object.hasOwn(selected,k)&&['direct','named'].includes(selected[k].provenance)),'corrupt');
 const named=v2?{}:at(s.evidence,path.slice(0,-3))?.namedStyles??s.evidence.namedStyles??{},name=v2?undefined:original.paragraph.paragraphStyle?.namedStyleType??'NORMAL_TEXT',base=(named.styles??[]).find(x=>x.namedStyleType===name)?.textStyle??{},style=v2?Object.fromEntries(props.map(k=>[k,selected[k].value])):{...base,...runs[0].textRun.textStyle};demand(props.every(k=>Object.hasOwn(style,k))&&only(style,props),'corrupt');if(v2){const f=style.weightedFontFamily;demand(only(f,['fontFamily','weight'])&&typeof f.fontFamily==='string'&&f.fontFamily.trim().length>0&&f.fontFamily.length<=100&&(!Object.hasOwn(f,'weight')||Number.isInteger(f.weight)&&f.weight>=100&&f.weight<=900&&f.weight%100===0),'corrupt');}
 const fragments=(a,z)=>runs.flatMap(r=>{const lo=Math.max(a,r.startIndex),hi=Math.min(z,r.endIndex);return hi>lo?[{text:r.textRun.content.slice(lo-r.startIndex,hi-r.startIndex),style:r.textRun.textStyle??{}}]:[];});
 const expected=joinPieces([...fragments(original.startIndex,start),...inserted?[{text:inserted,style}]:[],...fragments(end,original.endIndex)],v2);
 try{
  const left=structuredClone(s.evidence),right=structuredClone(after),lb=at(left,bodyPath),rb=at(right,bodyPath);if(!rb||rb.content.length!==lb.content.length)return {matched:false,changesMatched:false,preservationMatched:false,attribution:'notEstablished'};
  for(let i=0;i<lb.content.length;i++){
   const a=lb.content[i],z=rb.content[i];if(!a.paragraph)continue;const shift=i>index?delta:0;if(z.startIndex!==a.startIndex+shift||z.endIndex!==a.endIndex+(i>=index?delta:0))throw Error('shift');
   const actual=canonical(z.paragraph.elements,z.startIndex,z.endIndex,v2),old=canonical(a.paragraph.elements,a.startIndex,a.endIndex,v2);if(!sameLogical(actual,i===index?expected:old))throw Error('contentStyle');
   // Only independently checked known body extents and pure text topology normalize.
   z.startIndex-=shift;z.endIndex-=i>=index?delta:0;a.paragraph.elements=[];z.paragraph.elements=[];
  }
  if(v2){
   // Authority is the actual raw reference AND Reader-selected FONT property,
   // not the presentation default name or merely an available inherited parent.
   // The paragraph's actual namespace is root for flat docs, DocumentTab for tabs.
   const reference=original.paragraph.paragraphStyle?.namedStyleType,namedPath=[...path.slice(0,-3),'namedStyles'],defs=at(s.evidence,namedPath)?.styles??[],owners=new Set();
   if(typeof reference==='string'&&reference.length)for(const [i,id] of p.children.entries()){const raw=original.paragraph.elements[i].textRun.textStyle??{},node=s.nodes[id],property=node.style?.properties?.weightedFontFamily,inherited=node.style?.propertyEvidence?.weightedFontFamily?.inherited;if(Object.hasOwn(raw,'weightedFontFamily')||property?.provenance!=='named'||!inherited||property.source!==inherited.source)continue;const index=defs.findIndex(d=>d.namedStyleType===property.source);demand(index>=0&&sameLogical(defs[index].textStyle?.weightedFontFamily,property.value)&&sameLogical(inherited.value,property.value),'corrupt');owners.add(index);}
   for(const index of owners)for(const doc of [left,right]){const def=at(doc,namedPath)?.styles?.[index];if(def?.namedStyleType===defs[index].namedStyleType&&def.textStyle)def.textStyle=normalizeWeightStyle(def.textStyle);}
  }
  delete left.revisionId;delete right.revisionId;const matched=sameLogical(left,right);return {matched,changesMatched:true,preservationMatched:matched,attribution:'notEstablished'};
 }catch{return {matched:false,changesMatched:false,preservationMatched:false,attribution:'notEstablished'};}
}
