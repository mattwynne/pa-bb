// Independent whole-document observation verifier. NO compiler, planner, reducer,
// scalar comparator loop, or compiler-produced expected document.
import {boundedTree,LIMITS,scalar} from '../common.mjs';
import {validatedReadModel} from '../selectors.mjs';
import {assertCompositionPlan} from '../composition-plan.mjs';
import {sameLogical} from '../logical-plan.mjs';
import {demand} from '../draft-policy.mjs';
const at=(o,p)=>p.reduce((v,k)=>v?.[k],o),props=['bold','italic','underline','strikethrough','fontSize','weightedFontFamily','foregroundColor'];
const only=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>keys.includes(k));
function font(style){const f=style?.weightedFontFamily;if(!f||!only(f,['fontFamily','weight'])||typeof f.fontFamily!=='string'||!f.fontFamily.trim()||f.fontFamily.length>100||Object.hasOwn(f,'weight')&&(!Number.isInteger(f.weight)||f.weight<100||f.weight>900||f.weight%100!==0))return style;return {...style,weightedFontFamily:{...f,weight:Object.hasOwn(f,'weight')?f.weight:400}};}
function pieces(runs,start,end,v2){let pos=start;const out=[];demand(Array.isArray(runs),'corrupt');for(const r of runs){demand(only(r,['startIndex','endIndex','textRun'])&&only(r.textRun,['content','textStyle'])&&typeof r.textRun.content==='string'&&r.startIndex===pos&&Number.isSafeInteger(r.endIndex)&&r.endIndex===pos+r.textRun.content.length&&r.endIndex>pos,'corrupt');scalar(r.textRun.content);pos=r.endIndex;const style=r.textRun.textStyle??{};demand(style&&typeof style==='object'&&!Array.isArray(style),'corrupt');out.push({text:r.textRun.content,style:v2?font(style):style});}demand(pos===end,'corrupt');return merge(out,v2);}
function merge(items,v2){const out=[];for(const x of items){if(!x.text)continue;const style=v2?font(x.style):x.style,prev=out.at(-1);if(prev&&sameLogical(prev.style,style))prev.text+=x.text;else out.push({text:x.text,style});}return out;}
function replacement(s,node,c,v2){
 const raw=at(s.evidence,node.evidence.path),runs=raw.paragraph.elements,text=runs.map(r=>r.textRun.content).join('');let count=0,index=-1;for(let i=0;i<=text.length-c.oldText.length;i++)if(text.slice(i,i+c.oldText.length)===c.oldText){count++;index=i;}demand(count===1,'corrupt');
 const a=Array.from(c.oldText),b=Array.from(c.newText);let pre=0,suf=0;while(pre<Math.min(a.length,b.length)&&a[pre]===b[pre])pre++;while(suf<a.length-pre&&suf<b.length-pre&&a[a.length-1-suf]===b[b.length-1-suf])suf++;
 const start=raw.startIndex+index+a.slice(0,pre).join('').length,removed=a.slice(pre,a.length-suf).join(''),inserted=b.slice(pre,b.length-suf).join(''),end=start+removed.length;
 let style;if(v2){const selected=s.nodes[node.children[0]].style.properties;demand(props.every(k=>selected[k]&&['direct','named'].includes(selected[k].provenance)),'corrupt');style=Object.fromEntries(props.map(k=>[k,selected[k].value]));}
 else{const container=at(s.evidence,node.evidence.path.slice(0,-3)),name=raw.paragraph.paragraphStyle?.namedStyleType??'NORMAL_TEXT',defs=(container?.namedStyles??s.evidence.namedStyles)?.styles??[],base=defs.find(d=>d.namedStyleType===name)?.textStyle??{};style={...base,...runs[0].textRun.textStyle};}
 demand(only(style,props)&&props.every(k=>Object.hasOwn(style,k)),'corrupt');
 const span=(lo,hi)=>runs.flatMap(r=>{const a=Math.max(lo,r.startIndex),b=Math.min(hi,r.endIndex);return b>a?[{text:r.textRun.content.slice(a-r.startIndex,b-r.startIndex),style:r.textRun.textStyle??{}}]:[];});
 return {delta:c.newText.length-c.oldText.length,expected:merge([...span(raw.startIndex,start),...inserted?[{text:inserted,style}]:[],...span(end,raw.endIndex)],v2)};
}
export function compareParagraphComposition({plan,before,after}){
 const s=validatedReadModel(before);assertCompositionPlan(plan,{snapshot:s});demand(s.evidence.documentId===s.binding.documentId&&s.metadata.id===s.binding.documentId,'corrupt');
 try{
  boundedTree(after,LIMITS);const left=structuredClone(s.evidence),right=structuredClone(after),groups=new Map();
  // Resolve ONLY original node identities in the actual Reader graph.
  for(const part of plan.parts){const n=s.nodes[part.command.node];demand(n?.kind==='paragraph'&&n.segment.kind==='body'&&s.nodes[n.parent]?.kind==='segment','corrupt');const path=n.evidence.path,bodyPath=path.slice(0,-2),key=JSON.stringify(bodyPath);if(!groups.has(key))groups.set(key,{path:bodyPath,targets:new Map(),v2:false,text:false});const g=groups.get(key);demand(!g.targets.has(path.at(-1)),'corrupt');g.targets.set(path.at(-1),{node:n,command:part.command,v2:part.capabilityVersion==='paragraph-replace/2'});g.text||=part.command.op==='paragraphReplace';g.v2||=part.capabilityVersion==='paragraph-replace/2';}
  for(const g of groups.values()){
   const lb=at(left,g.path),rb=at(right,g.path);demand(lb&&rb&&Array.isArray(lb.content)&&Array.isArray(rb.content)&&lb.content.length===rb.content.length,'corrupt');
   if(!g.text){for(const [i,t]of g.targets){const a=lb.content[i],z=rb.content[i];demand(z?.paragraph?.elements?.length===a.paragraph.elements.length,'corrupt');for(let j=0;j<a.paragraph.elements.length;j++){const ar=a.paragraph.elements[j],zr=z.paragraph.elements[j];demand(zr.textRun?.textStyle?.bold===t.command.bold&&zr.textRun.content===ar.textRun.content&&zr.startIndex===ar.startIndex&&zr.endIndex===ar.endIndex,'corrupt');for(const r of [ar,zr]){if(r.textRun.textStyle){delete r.textRun.textStyle.bold;if(!Object.keys(r.textRun.textStyle).length)delete r.textRun.textStyle;}}}}continue;}
   let shift=0;
   for(let i=0;i<lb.content.length;i++){
    const a=lb.content[i],z=rb.content[i],t=g.targets.get(i);if(!a.paragraph)continue;
    let delta=0,expected=pieces(a.paragraph.elements,a.startIndex,a.endIndex,g.v2);
    if(t?.command.op==='paragraphReplace'){const effect=replacement(s,t.node,t.command,t.v2);delta=effect.delta;expected=merge(effect.expected,g.v2);}
    else if(t){expected=merge(a.paragraph.elements.map(r=>({text:r.textRun.content,style:{...r.textRun.textStyle,bold:t.command.bold}})),g.v2);}
    demand(z.startIndex===a.startIndex+shift&&z.endIndex===a.endIndex+shift+delta,'corrupt');demand(sameLogical(pieces(z.paragraph.elements,z.startIndex,z.endIndex,g.v2),expected),'corrupt');
    z.startIndex-=shift;z.endIndex-=shift+delta;a.paragraph.elements=[];z.paragraph.elements=[];shift+=delta;
   }
   // /2's documented default ONLY at actual active inherited font owners.
   for(const t of g.targets.values())if(t.v2){const original=at(s.evidence,t.node.evidence.path),namedPath=[...t.node.evidence.path.slice(0,-3),'namedStyles'],defs=at(s.evidence,namedPath)?.styles??[],owners=new Set();
    if(typeof original.paragraph.paragraphStyle?.namedStyleType==='string')for(const [i,id]of t.node.children.entries()){const raw=original.paragraph.elements[i].textRun.textStyle??{},n=s.nodes[id],property=n.style?.properties?.weightedFontFamily,inherited=n.style?.propertyEvidence?.weightedFontFamily?.inherited;if(Object.hasOwn(raw,'weightedFontFamily')||property?.provenance!=='named'||!inherited||property.source!==inherited.source)continue;const index=defs.findIndex(d=>d.namedStyleType===property.source);demand(index>=0&&sameLogical(defs[index].textStyle?.weightedFontFamily,property.value)&&sameLogical(inherited.value,property.value),'corrupt');owners.add(index);}
    for(const index of owners)for(const doc of [left,right]){const def=at(doc,namedPath)?.styles?.[index];demand(def?.namedStyleType===defs[index].namedStyleType&&def.textStyle,'corrupt');def.textStyle=font(def.textStyle);}
   }
  }
  delete left.revisionId;delete right.revisionId;const matched=sameLogical(left,right);return {matched,changesMatched:true,preservationMatched:matched,attribution:'notEstablished'};
 }catch{return {matched:false,changesMatched:false,preservationMatched:false,attribution:'notEstablished'};}
}
