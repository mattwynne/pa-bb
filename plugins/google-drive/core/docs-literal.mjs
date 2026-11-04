// Bounded body-paragraph literal editing. No drafts, journal, host or provider I/O.
const fail=(code='unsupported_document')=>{throw Object.assign(new Error('Docs literal '+code),{docsCode:code});};
const scalar=s=>typeof s==='string'&&s.isWellFormed();
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>JSON.stringify(x,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>canonical(a)===canonical(b);
const fields=['bold','italic','underline','strikethrough','smallCaps','backgroundColor','foregroundColor','fontSize','weightedFontFamily','baselineOffset','link'];
export function style(value={}){
 if(!object(value)||Object.keys(value).some(k=>!fields.includes(k)||k==='link'))fail();
 for(const [k,v]of Object.entries(value)){
  if(fields.slice(0,5).includes(k)){if(typeof v!=='boolean')fail();}
  else if(k==='fontSize'){if(!object(v)||Object.keys(v).sort().join(',')!=='magnitude,unit'||v.unit!=='PT'||!Number.isFinite(v.magnitude)||v.magnitude<=0)fail();}
  else if(k==='weightedFontFamily'){if(!object(v)||Object.keys(v).some(k=>!['fontFamily','weight'].includes(k))||!scalar(v.fontFamily)||/[\p{Cc}\p{Cs}]/u.test(v.fontFamily)||!v.fontFamily.trim()||v.fontFamily.length>100||('weight'in v&&(!Number.isInteger(v.weight)||v.weight<100||v.weight>900||v.weight%100)))fail();}
  else if(k==='baselineOffset'){if(!['NORMAL','SUPERSCRIPT','SUBSCRIPT'].includes(v))fail();}
  else if(object(v)&&Object.keys(v).length===0)continue; // OptionalColor: explicitly transparent, not a guessed RGB value.
  else if(!object(v)||Object.keys(v).join(',')!=='color'||!object(v.color)||Object.keys(v.color).join(',')!=='rgbColor'||!object(v.color.rgbColor)||Object.entries(v.color.rgbColor).some(([k,n])=>!['red','green','blue'].includes(k)||!Number.isFinite(n)||n<0||n>1))fail();
 }
 return value;
}
const bounds=n=>object(n)&&Number.isSafeInteger(n.startIndex??0)&&Number.isSafeInteger(n.endIndex)&&(n.startIndex??0)>=0&&n.endIndex>=(n.startIndex??0);
export function bodyWalk(content,visit,depth=0,allowEmpty=false){
 if(depth>16||!Array.isArray(content))fail();let previous=0;
 for(const item of content){
  if(!bounds(item)||(item.startIndex??0)<previous||['paragraph','table','tableOfContents','sectionBreak'].filter(k=>Object.hasOwn(item,k)).length!==1)fail();previous=item.endIndex;
  if(!object(item)||Object.keys(item).some(k=>!['startIndex','endIndex','paragraph','table','tableOfContents','sectionBreak'].includes(k))||!Number.isSafeInteger(item.endIndex)||!Number.isSafeInteger(item.startIndex??0)||(item.startIndex??0)<0||item.endIndex<(item.startIndex??0))fail();visit(item);
  if(item.paragraph){if(!Array.isArray(item.paragraph.elements))fail();if(!item.paragraph.elements.length){if(!allowEmpty)fail();continue;}let position=item.startIndex;for(const part of item.paragraph.elements){if(!Number.isSafeInteger(part.startIndex)||!Number.isSafeInteger(part.endIndex)||part.endIndex<=part.startIndex||part.startIndex!==position||part.endIndex>item.endIndex)fail();if(part.textRun&&(!scalar(part.textRun.content)||part.endIndex-part.startIndex!==part.textRun.content.length))fail();position=part.endIndex;visit(part);}if(position!==item.endIndex||!item.paragraph.elements.at(-1).textRun?.content?.endsWith('\n')||item.paragraph.elements.some((p,i)=>p.textRun?.content?.includes('\n')&&(i!==item.paragraph.elements.length-1||p.textRun.content.indexOf('\n')!==p.textRun.content.length-1)))fail();}
  else if(item.table){if(!Array.isArray(item.table.tableRows))fail();for(const row of item.table.tableRows){if(!bounds(row)||(row.startIndex??0)<(item.startIndex??0)||row.endIndex>item.endIndex)fail();visit(row);if(!Array.isArray(row.tableCells))fail();for(const cell of row.tableCells){if(!bounds(cell)||(cell.startIndex??0)<(row.startIndex??0)||cell.endIndex>row.endIndex||!Array.isArray(cell.content)||cell.content.some(n=>!bounds(n)||(n.startIndex??0)<(cell.startIndex??0)||n.endIndex>cell.endIndex))fail();visit(cell);bodyWalk(cell.content,visit,depth+1,allowEmpty);}}}
  else if(item.tableOfContents)bodyWalk(item.tableOfContents.content,visit,depth+1,allowEmpty);
  else if(!item.sectionBreak)fail();
 }
}
export function inspectLiteralDocument(raw,id){
 if(Buffer.byteLength(JSON.stringify(raw)??'')>1048576)fail();
 function suggestions(value,depth=0){if(depth>64)fail();if(!object(value)&&!Array.isArray(value))return;for(const [k,v]of Object.entries(value)){if((k.startsWith('suggested')||k==='suggestions')&&v!=null&&(typeof v!=='object'||Object.keys(v).length))fail();suggestions(v,depth+1);}}
 suggestions(raw);
 if(raw?.documentId!==id||!scalar(raw.revisionId)||!raw.revisionId||raw.revisionId.length>2048||raw.suggestionsViewMode!=='SUGGESTIONS_INLINE'||!Array.isArray(raw.tabs)||!raw.tabs.length)fail();
 for(const key of ['body','headers','footers','footnotes'])if(Object.keys(raw[key]??{}).length)fail();
 const tabs=[];let units=0;
 function visit(nodes,depth=0){if(depth>16||!Array.isArray(nodes))fail();for(const tab of nodes){
  const tabId=tab.tabProperties?.tabId,data=tab.documentTab;
  if(typeof tabId!=='string'||!tabId||tabId.length>256||tabs.some(t=>t.tabId===tabId)||tabs.length>=16||!Array.isArray(data?.body?.content))fail();
  if(Object.keys(tab).some(k=>!['tabProperties','documentTab','childTabs'].includes(k)))fail();
  for(const key of ['headers','footers','footnotes'])if(Object.keys(data[key]??{}).length)fail();
  bodyWalk(data.body.content,()=>{});
  let text='';const runs=[];
  function collect(content,nested=false,level=0){if(level>16||!Array.isArray(content))fail();for(const [index,item]of content.entries()){
   if(item.paragraph){for(const [partIndex,part]of (item.paragraph.elements??[]).entries()){
    if(typeof part.textRun?.content==='string'){const value=part.textRun.content;if(!scalar(value))fail();if(!nested)runs.push({offset:text.length,text:value,index,partIndex,startIndex:part.startIndex});text+=value;}
    else text+='\uFFFC';
   }}else if(item.table){for(const row of item.table.tableRows??[])for(const cell of row.tableCells??[])collect(cell.content,true,level+1);}
   else if(item.tableOfContents)collect(item.tableOfContents.content,true,level+1);
   else if(!item.sectionBreak)text+='\uFFFC';
  }}collect(data.body.content);
  units+=text.length;if(units>50000)fail();
  tabs.push({tabId,title:String(tab.tabProperties.title??'').slice(0,256),text,runs,data});if(tab.childTabs)visit(tab.childTabs,depth+1);
 }}visit(raw.tabs);
 return {profile:'body-literal/1',raw,documentId:id,revisionId:raw.revisionId,title:String(raw.title??'').slice(0,500),tabs};
}
function target(snapshot,args){
 if(snapshot.revisionId!==args.expectedRevisionId)fail('stale_revision');
 const tab=snapshot.tabs.find(t=>t.tabId===args.tabId),offset=tab?.text.indexOf(args.oldText)??-1;
 if(offset<0||tab.text.indexOf(args.oldText,offset+1)!==-1)fail('match_not_unique');
 const run=tab.runs.find(r=>offset>=r.offset&&offset+args.oldText.length<=r.offset+r.text.length);if(!run)fail('match_not_unique');
 if(Object.keys(tab.data).some(k=>!['body','headers','footers','footnotes','inlineObjects','positionedObjects','documentStyle','namedStyles','lists','namedRanges','suggestedDocumentStyleChanges','suggestedNamedStylesChanges','commentAnchors','dropdownDefinitions'].includes(k))||Object.keys(tab.data.body).some(k=>k!=='content'))fail();
 const element=tab.data.body.content[run.index],parts=element.paragraph.elements;
 let end=element.startIndex;
 for(const p of parts){if(Object.keys(p).some(k=>!['startIndex','endIndex','textRun'].includes(k))||!scalar(p.textRun?.content)||!p.textRun.content.length||Object.keys(p.textRun).some(k=>!['content','textStyle'].includes(k))||p.startIndex!==end||p.endIndex!==end+p.textRun.content.length)fail();end=p.endIndex;style(p.textRun.textStyle);}
 const text=parts.map(p=>p.textRun.content).join('');if(end!==element.endIndex||!text.endsWith('\n')||text.indexOf('\n')!==text.length-1)fail();
 // These index-bearing registries need a separate transformation contract. Other
 // tabs, headers, objects and tables are preserved, not treated as edit targets.
 for(const key of ['namedRanges','bookmarks','commentAnchors'])if(Object.keys(tab.data[key]??{}).length||Object.keys(snapshot.raw[key]??{}).length)fail();
 bodyWalk(tab.data.body.content,()=>{});
 const textStyle=style(parts[run.partIndex].textRun.textStyle),startIndex=run.startIndex+offset-run.offset;
 return {tab,run,element,offset,startIndex,endIndex:startIndex+args.oldText.length,textStyle};
}
export function planLiteralEdit(snapshot,args){
 const t=target(snapshot,args);
 const plan={profile:'body-literal/1',documentId:snapshot.documentId,expectedRevisionId:snapshot.revisionId,tabId:args.tabId,startIndex:t.startIndex,endIndex:t.endIndex,oldText:args.oldText,newText:args.newText,textStyle:structuredClone(t.textStyle)};
 literalRequests(plan);return plan;
}
export function literalRequests(p){
 if(p?.profile!=='body-literal/1'||!Number.isSafeInteger(p.startIndex)||p.startIndex<1||p.endIndex!==p.startIndex+p.oldText?.length||!scalar(p.oldText)||!p.oldText.length||!scalar(p.newText)||[p.oldText,p.newText].some(s=>s.length>2000||/[\u0000-\u001f\u007f-\u009f\uE000-\uF8FF\u2028\u2029]/u.test(s))||p.oldText===p.newText||typeof p.tabId!=='string'||!p.tabId)fail('invalid_input');
 style(p.textStyle);
 const range={tabId:p.tabId,startIndex:p.startIndex,endIndex:p.endIndex};
 return [{deleteContentRange:{range}},...p.newText.length?[{insertText:{location:{tabId:p.tabId,index:p.startIndex},text:p.newText}},{updateTextStyle:{range:{...range,endIndex:p.startIndex+p.newText.length},textStyle:p.textStyle,fields:fields.join(',')}}]:[]];
}
// Google documents weight=400 when an explicitly named font omits weight.
// Only real textRun styles in the affected paragraph use this equivalence;
// untouched definitions, other paragraphs/tabs and opaque metadata stay exact.
function observedStyle(value){const f=value?.weightedFontFamily;return object(f)&&Object.keys(f).every(k=>['fontFamily','weight'].includes(k))&&scalar(f.fontFamily)&&f.fontFamily.length<=100&&f.fontFamily.trim()&&!/[\p{Cc}\p{Cs}]/u.test(f.fontFamily)&&(!Object.hasOwn(f,'weight')||f.weight===400)?{...value,weightedFontFamily:{...f,weight:400}}:value;}
export function pieces(elements,start,end){let pos=start;const out=[];for(const p of elements){if(!scalar(p.textRun?.content)||!p.textRun.content.length||p.startIndex!==pos||p.endIndex!==pos+p.textRun.content.length||Object.keys(p).some(k=>!['startIndex','endIndex','textRun'].includes(k))||Object.keys(p.textRun).some(k=>!['content','textStyle'].includes(k)))fail();pos=p.endIndex;const last=out.at(-1),value={text:p.textRun.content,style:observedStyle(p.textRun.textStyle??{})};if(last&&same(last.style,value.style))last.text+=value.text;else out.push(value);}if(pos!==end)fail();return out;}
// Only explicit same-tab named-style observations establish parent values.
// Unknown editor defaults, ambiguous definitions and links stay unknown.
export function knownTextParent(data, paragraph) {
 const named = data.namedStyles?.styles;
 const type = paragraph.paragraphStyle?.namedStyleType;
 if (!Array.isArray(named) || !type) return {};
 const normal = named.filter(n => n.namedStyleType === 'NORMAL_TEXT');
 const selected = named.filter(n => n.namedStyleType === type);
 if (normal.length !== 1 || selected.length !== 1 || [normal[0].textStyle,selected[0].textStyle].some(s => s !== undefined && !object(s))) return {};
 const inherited = {...normal[0].textStyle, ...selected[0].textStyle}, known = {};
 for (const key of fields) {
  if (key === 'link' || !Object.hasOwn(inherited,key)) continue;
  try { style({[key]:inherited[key]}); known[key] = inherited[key]; } catch { /* unsupported parent value is not a known default */ }
 }
 return observedStyle(known);
}
// UpdateTextStyle can unset direct values equal to the parent. Resolve that
// equivalence ONLY inside the actual updated span, splitting coalesced runs at
// its boundaries. Unmodified prefixes, suffixes and newlines stay direct/exact
// under the pre-existing pieces contract; no paragraph-wide inheritance pass.
export function updatedPieces(elements,start,end,updatedStart,updatedEnd,parent) {
 const out = [];
 let position = start;
 for (const piece of pieces(elements,start,end)) {
  const next = position + piece.text.length;
  const boundaries = [...new Set([position,next,Math.max(position,Math.min(next,updatedStart)),Math.max(position,Math.min(next,updatedEnd))])].sort((a,b) => a-b);
  for (let i=0;i<boundaries.length-1;i++) {
   const a = boundaries[i], b = boundaries[i+1];
   const value = {text:piece.text.slice(a-position,b-position),style:a >= updatedStart && b <= updatedEnd ? {...parent,...piece.style} : piece.style};
   const last = out.at(-1);
   if (last && same(last.style,value.style)) last.text += value.text; else out.push(value);
  }
  position = next;
 }
 return out;
}
// Image contentUri is a requester-tagged, expiring read URL, not a durable
// document-content identity. Ignore only that known output field when BOTH
// observations have it at the same image-object slot; all other fields stay exact.
export function stableObservations(before,after){
 const left=structuredClone(before),right=structuredClone(after);
 function maps(a,b,kind){if(!object(a)||!object(b))return;for(const [id,value]of Object.entries(a)){const x=value?.[kind]?.embeddedObject?.imageProperties,y=b[id]?.[kind]?.embeddedObject?.imageProperties;if(typeof x?.contentUri==='string'&&x.contentUri&&typeof y?.contentUri==='string'&&y.contentUri){delete x.contentUri;delete y.contentUri;}}}
 function data(a,b){maps(a?.inlineObjects,b?.inlineObjects,'inlineObjectProperties');maps(a?.positionedObjects,b?.positionedObjects,'positionedObjectProperties');}
 function tabs(a,b){if(!Array.isArray(a)||!Array.isArray(b))return;for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i].tabProperties?.tabId===b[i].tabProperties?.tabId){data(a[i].documentTab,b[i].documentTab);tabs(a[i].childTabs,b[i].childTabs);}}
 data(left,right);tabs(left?.tabs,right?.tabs);return [left,right];
}
export function literalSourceMatches(before,current){if(!object(before)||!before.documentId||!object(current))return false;const [left,right]=stableObservations(before,current);return same(left,right);}
export function literalReadbackMatches(before,after,args){
 try{
  const snapshot=inspectLiteralDocument(before,before.documentId),t=target(snapshot,args),delta=args.newText.length-args.oldText.length;
  const [left,right]=stableObservations(before,after);if(right.documentId!==left.documentId||!scalar(right.revisionId)||!right.revisionId) return false;
  const find=doc=>{let result;const visit=tabs=>{for(const tab of tabs){if(tab.tabProperties?.tabId===args.tabId)result=tab.documentTab;if(tab.childTabs)visit(tab.childTabs);}};visit(doc.tabs);return result;};
  const a=find(left),b=find(right),source=a.body.content[t.run.index],actual=b.body.content[t.run.index];
  const expected=structuredClone(source.paragraph.elements),chosen=expected[t.run.partIndex],at=t.startIndex-chosen.startIndex;
  chosen.textRun.content=chosen.textRun.content.slice(0,at)+args.newText+chosen.textRun.content.slice(at+args.oldText.length);chosen.endIndex+=delta;
  for(let i=t.run.partIndex+1;i<expected.length;i++){expected[i].startIndex+=delta;expected[i].endIndex+=delta;}
  const parent = knownTextParent(a,source.paragraph), updatedEnd = t.startIndex+args.newText.length;
  if(!same(updatedPieces(expected.filter(p=>p.textRun.content.length),source.startIndex,source.endIndex+delta,t.startIndex,updatedEnd,parent),updatedPieces(actual.paragraph.elements,source.startIndex,source.endIndex+delta,t.startIndex,updatedEnd,parent)))return false;
  source.paragraph.elements=[];actual.paragraph.elements=[];
  const originals=[],observed=[];bodyWalk(a.body.content,n=>originals.push(n),0,true);bodyWalk(b.body.content,n=>observed.push(n),0,true);if(originals.length!==observed.length)return false;
  for(let i=0;i<originals.length;i++){
   const x=originals[i],y=observed[i];
   for(const k of ['startIndex','endIndex']){
    if(!Object.hasOwn(x,k)){if(Object.hasOwn(y,k))return false;continue;}
    const shift=x===source?(k==='endIndex'?delta:0):x[k]>=t.endIndex?delta:0;
    if(y[k]!==x[k]+shift)return false;y[k]=x[k];
   }
  }
  delete left.revisionId;delete right.revisionId;return same(left,right);
 }catch{return false;}
}
