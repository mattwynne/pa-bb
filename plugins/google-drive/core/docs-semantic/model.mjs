import { LIMITS, boundedTree, digest, freeze, requireValue, scalar, jsonBytes } from './common.mjs';
const blockKinds=['paragraph','table','sectionBreak','tableOfContents'];
const inlineKinds=['textRun','inlineObjectElement','person','richLink','dateElement','dropdown','footnoteReference','pageBreak','columnBreak','horizontalRule','equation','autoText'];
// Exact ParagraphElement classes with a TextStyle reference in pinned discovery.
// Equation and opaque future elements are not TextStyle owners.
const textStyleKinds=new Set(['textRun','inlineObjectElement','person','richLink','dateElement','dropdown','footnoteReference','pageBreak','columnBreak','horizontalRule','autoText']);
const registryNames=['lists','namedStyles','namedRanges','inlineObjects','positionedObjects','bookmarks','dropdownDefinitions','commentAnchors'];
// Pinned Docs schema 20261026: inheritance is at style-property boundaries,
// not a recursive JSON merge. A partial border/dimension/font replaces that
// whole property; missing members never borrow from a different definition.
const textProperties=new Set(['fontSize','link','strikethrough','bold','weightedFontFamily','foregroundColor','underline','backgroundColor','smallCaps','baselineOffset','italic']);
const paragraphProperties=new Set(['borderBottom','alignment','borderTop','borderLeft','keepLinesTogether','lineSpacing','indentStart','borderBetween','spaceBelow','shading','namedStyleType','spaceAbove','headingId','direction','borderRight','indentEnd','tabStops','keepWithNext','pageBreakBefore','avoidWidowAndOrphan','indentFirstLine','spacingMode']);
const nonInherited=new Set(['link','headingId','direction','tabStops','namedStyleType']);
const inheritanceSentinels={baselineOffset:'BASELINE_OFFSET_UNSPECIFIED',alignment:'ALIGNMENT_UNSPECIFIED',spacingMode:'SPACING_MODE_UNSPECIFIED'};
const inherits=(key,value)=>Object.hasOwn(inheritanceSentinels,key)&&value===inheritanceSentinels[key];
const styleEnums={alignment:['ALIGNMENT_UNSPECIFIED','START','CENTER','END','JUSTIFIED'],baselineOffset:['BASELINE_OFFSET_UNSPECIFIED','NONE','SUPERSCRIPT','SUBSCRIPT'],
  direction:['CONTENT_DIRECTION_UNSPECIFIED','LEFT_TO_RIGHT','RIGHT_TO_LEFT'],spacingMode:['SPACING_MODE_UNSPECIFIED','NEVER_COLLAPSE','COLLAPSE_LISTS'],
  namedStyleType:['NAMED_STYLE_TYPE_UNSPECIFIED','NORMAL_TEXT','TITLE','SUBTITLE','HEADING_1','HEADING_2','HEADING_3','HEADING_4','HEADING_5','HEADING_6'],
  contentDirection:['CONTENT_DIRECTION_UNSPECIFIED','LEFT_TO_RIGHT','RIGHT_TO_LEFT'],
  sectionType:['SECTION_TYPE_UNSPECIFIED','CONTINUOUS','NEXT_PAGE'],columnSeparatorStyle:['COLUMN_SEPARATOR_STYLE_UNSPECIFIED','NONE','BETWEEN_EACH_COLUMN']};
// Unknown/unspecified typed values are retained, never treated as concrete units
// or layout. Owning-property inheritance sentinels are handled separately.
const concreteEnums=Object.fromEntries(Object.entries(styleEnums).map(([key,values])=>[key,new Set(values.filter(value=>!value.endsWith('_UNSPECIFIED')))]));
const dimensionUnit=new Set(['PT']),dashStyle=new Set(['SOLID','DOT','DASH']);
const tabAlignment=new Set(['START','CENTER','END']),documentMode=new Set(['PAGES','PAGELESS']);
const dimensions=new Set(['fontSize','spaceAbove','spaceBelow','indentStart','indentEnd','indentFirstLine','marginTop','marginBottom','marginLeft','marginRight','marginHeader','marginFooter']);
const dimensionShape={magnitude:'number',unit:dimensionUnit};
const optionalColorShape={color:{rgbColor:{red:'number',green:'number',blue:'number'}}};
const booleanStyles=new Set(['strikethrough','bold','underline','smallCaps','italic','keepLinesTogether','keepWithNext','pageBreakBefore','avoidWidowAndOrphan']);
function propertyShape(key) {
  if(Object.hasOwn(concreteEnums,key))return concreteEnums[key];
  if(dimensions.has(key))return dimensionShape;
  if(key==='weightedFontFamily')return {fontFamily:'string',weight:'number'};
  if(key.startsWith('border'))return {color:optionalColorShape,width:dimensionShape,dashStyle,padding:dimensionShape};
  if(['foregroundColor','backgroundColor'].includes(key))return optionalColorShape;
  if(key==='link')return {url:'string',tabId:'string',headingId:'string',bookmarkId:'string',heading:{id:'string',tabId:'string'},bookmark:{id:'string',tabId:'string'}};
  if(key==='shading')return {backgroundColor:optionalColorShape};
  if(key==='background')return {color:optionalColorShape};
  if(key==='pageSize')return {width:dimensionShape,height:dimensionShape};
  if(key==='documentFormat')return {documentMode};
  if(key==='columnProperties')return [{width:dimensionShape,paddingEnd:dimensionShape}];
  if(['useEvenPageHeaderFooter','useFirstPageHeaderFooter','useCustomHeaderFooterMargins','flipPageOrientation'].includes(key))return 'boolean';
  if(key==='pageNumberStart')return 'number';
  if(key==='tabStops')return [{offset:dimensionShape,alignment:tabAlignment}];
  if(booleanStyles.has(key))return 'boolean';
  return key==='lineSpacing'?'number':'string';
}
function propertyFacts(key,value,known) {
  const leaves=Object.create(null),unknown=[],missing=[];
  function visit(v,shape,path){
    const arrayShape=Array.isArray(shape);
    const objectShape=shape!==null&&typeof shape==='object'&&!arrayShape&&!(shape instanceof Set);
    const recognized=shape instanceof Set?shape.has(v):typeof shape==='string'?typeof v===shape:
      arrayShape?Array.isArray(v):objectShape?v!==null&&typeof v==='object'&&!Array.isArray(v):false;
    // Check this boundary before lending any child a schema. Numeric-keyed
    // objects are not arrays; malformed containers remain whole raw evidence.
    if(!recognized){leaves[path]={stored:v,status:'unknownSchema'};unknown.push(path);return;}
    if(shape===dimensionShape)
      for(const field of ['magnitude','unit'])if(!Object.hasOwn(v,field))missing.push(`${path}.${field}`);
    if((arrayShape||objectShape)&&Object.keys(v).length){
      for(const [name,child] of Object.entries(v))
        visit(child,arrayShape?shape[0]:Object.hasOwn(shape,name)?shape[name]:undefined,`${path}.${name}`);
    }else leaves[path]={stored:v,status:'observed'};
  }
  visit(value,known?propertyShape(key):null,key);
  if(key==='weightedFontFamily'&&value&&typeof value==='object')for(const field of ['fontFamily','weight'])if(!Object.hasOwn(value,field))missing.push(`${key}.${field}`);
  if(key.startsWith('border')&&value&&typeof value==='object'){
    for(const field of ['color','width','dashStyle','padding'])if(!Object.hasOwn(value,field))missing.push(`${key}.${field}`);
  }
  return {atomic:true,leaves,unknown,missing,effectiveStatus:!known||unknown.length||missing.length?'partialOrUnknown':'observed'};
}
// Read-side property classification reuses the same atomic schema semantics as
// materialization. This is not a writable-field or compiler permission check.
export function inspectStyleProperty(family,key,value) {
  requireValue(['text','paragraph'].includes(family),'invalid');
  return propertyFacts(key,value,(family==='text'?textProperties:paragraphProperties).has(key));
}
function styleEvidence(explicit={}, named={}, source, normal={}, type='text') {
  const properties=Object.create(null),inherited=Object.create(null),facts=Object.create(null),unknownParents=[];
  const known=type==='paragraph'?paragraphProperties:textProperties;
  for(const [parent,parentSource] of [[normal,'NORMAL_TEXT'],[named,source]]) {
    for(const [key,value] of Object.entries(parent)) {
      if(!known.has(key)){unknownParents.push({source:parentSource,field:key,digest:digest(value)});continue;}
      if(nonInherited.has(key)||inherits(key,value))continue;
      inherited[key]={value,provenance:'named',source:parentSource};
    }
  }
  Object.assign(properties,inherited);
  for(const [key,value] of Object.entries(explicit)) {
    if(inherits(key,value))continue;
    properties[key]=known.has(key)?{value,provenance:'direct'}:{value,provenance:'unknown'};
  }
  for(const [key,entry] of Object.entries(properties))facts[key]={...propertyFacts(key,entry.value,known.has(key)),inherited:inherited[key]??null};
  for(const [key,value] of Object.entries(explicit))if(inherits(key,value)&&!facts[key])facts[key]={effectiveStatus:'unknownParent',inherited:null};
  // Keep the empty/unknown case small (and compatible with existing exact page
  // boundary vectors). No default named type, font or editor value is invented.
  return {explicit,properties,absent:'unknown',...(Object.keys(facts).length?{propertyEvidence:facts}: {}),
    ...(unknownParents.length?{unknownParentProperties:unknownParents}: {})};
}
const pageOnly=new Set(['pageSize','marginTop','marginBottom','marginLeft','marginRight','marginHeader','marginFooter','defaultHeaderId','defaultFooterId','evenPageHeaderId','evenPageFooterId','firstPageHeaderId','firstPageFooterId','useEvenPageHeaderFooter','useFirstPageHeaderFooter','useCustomHeaderFooterMargins','flipPageOrientation','pageNumberStart']);
function layoutEffective(key,value,facts,documentStyle) {
  if(documentStyle.documentFormat?.documentMode==='PAGELESS'&&pageOnly.has(key))return {status:'notApplicableInPageless'};
  if(['marginHeader','marginFooter'].includes(key)&&documentStyle.useCustomHeaderFooterMargins===false)return {status:'notAppliedWhenCustomMarginsDisabled'};
  return facts.effectiveStatus==='observed'?{status:'storedApiValue',value}:{status:'partialOrUnknown'};
}
function documentStyleEvidence(stored) {
  requireValue(stored&&typeof stored==='object'&&!Array.isArray(stored),'invalid');
  const properties=Object.create(null);
  for(const [key,value] of Object.entries(stored)){
    const known=pageOnly.has(key)||['background','documentFormat'].includes(key);
    const facts=propertyFacts(key,value,known);
    properties[key]={stored:value,provenance:'direct',propertyEvidence:facts,
      effective:layoutEffective(key,value,facts,stored)};
  }
  return {stored,properties,absent:'unknown',rendering:'notVerified'};
}
const sectionHeaders=['defaultHeaderId','defaultFooterId','firstPageHeaderId','firstPageFooterId','evenPageHeaderId','evenPageFooterId'];
const sectionDocumentDefaults=['marginTop','marginBottom','marginLeft','marginRight','marginHeader','marginFooter','flipPageOrientation'];
const sectionProperties=new Set([...sectionHeaders,...sectionDocumentDefaults,'useFirstPageHeaderFooter','pageNumberStart','sectionType','contentDirection','columnProperties','columnSeparatorStyle']);
function sectionStyleEvidence(stored,documentStyle,previous) {
  requireValue(stored&&typeof stored==='object'&&!Array.isArray(stored),'invalid');
  const properties=Object.create(null);
  function assign(key,value,provenance,source){
    const facts=propertyFacts(key,value,sectionProperties.has(key));
    properties[key]={value,provenance,source,propertyEvidence:facts,effective:layoutEffective(key,value,facts,documentStyle)};
  }
  for(const key of sectionDocumentDefaults)if(Object.hasOwn(documentStyle,key))assign(key,documentStyle[key],'document',{kind:'documentStyle'});
  for(const key of sectionHeaders){
    if(previous?.style.properties[key])assign(key,previous.style.properties[key].value,'previousSection',{node:previous.id});
    else if(!previous&&Object.hasOwn(documentStyle,key))assign(key,documentStyle[key],'document',{kind:'documentStyle'});
  }
  if(!previous)for(const key of ['useFirstPageHeaderFooter','pageNumberStart'])if(Object.hasOwn(documentStyle,key))assign(key,documentStyle[key],'document',{kind:'documentStyle'});
  for(const [key,value] of Object.entries(stored))assign(key,value,sectionProperties.has(key)?'direct':'unknown',null);
  return {stored,properties,absent:'unknown',rendering:'notVerified',
    ...(previous&&!Object.hasOwn(stored,'pageNumberStart')?{pageNumberContinuation:'previousSection; numericValueNotKnown'}:{})};
}
const reviewFields=['suggestedInsertionIds','suggestedDeletionIds','suggestedTextStyleChanges','suggestedParagraphStyleChanges',
  'suggestedBulletChanges','suggestedPositionedObjectIds','suggestedTableRowStyleChanges','suggestedTableCellStyleChanges','commentIds'];
// Validate the aggregate dense topology before any grid or model is allocated.
// Physical cells are serialized once; covered visual coordinates are aliases.
function topologyBudget(document,limits) {
  let slots=0;
  function sequence(content){
    requireValue(Array.isArray(content));
    for(const raw of content){
      if(raw?.table){
        const {rows,columns,tableRows}=raw.table;
        requireValue(Number.isSafeInteger(rows)&&Number.isSafeInteger(columns)&&rows>=0&&columns>=0,'extent');
        requireValue(rows<=limits.topologySlots&&columns<=limits.topologySlots,'budget');
        requireValue((rows===0)===(columns===0),'extent');
        requireValue(columns===0||rows<=Math.floor((limits.topologySlots-slots)/columns),'budget');
        slots+=rows*columns;
        requireValue(Array.isArray(tableRows)&&tableRows.length===rows,'extent');
        for(const row of tableRows){
          requireValue(Array.isArray(row.tableCells),'extent');
          for(const cell of row.tableCells){
            const {rowSpan=1,columnSpan=1}=cell.tableCellStyle??{};
            requireValue(Number.isSafeInteger(rowSpan)&&rowSpan>0&&rowSpan<=rows&&Number.isSafeInteger(columnSpan)&&columnSpan>0&&columnSpan<=columns,'extent');
            sequence(cell.content);
          }
        }
      }
      if(raw?.tableOfContents)sequence(raw.tableOfContents.content);
    }
  }
  function visit(tabs){
    requireValue(Array.isArray(tabs));
    for(const tab of tabs){
      const body=tab.documentTab;requireValue(body,'unavailable');sequence(body.body?.content);
      for(const key of ['headers','footers','footnotes'])for(const segment of Object.values(body[key]??{}))sequence(segment.content);
      if(tab.childTabs)visit(tab.childTabs);
    }
  }
  visit(document.tabs);return slots;
}
// Validate partial constraints both when creating a model and when consuming
// stored witness evidence. Missing ends stay missing; no coordinates are repaired.
export function validateStructuralFacts({nodes,evidence}){
  const bounds=new Map();
  // Models persist parent-first insertion order. Reverse traversal visits every
  // physical edge once; visual grid aliases are not duplicate child contents.
  for(const n of Object.values(nodes).reverse()){
    const raw=n.evidence.path.reduce((value,key)=>value[key],evidence);
    if(raw.startIndex!==undefined)requireValue(Number.isSafeInteger(raw.startIndex)&&raw.startIndex>=0,'extent');
    const start=raw.startIndex??n.extent?.start,end=n.extent?.end;
    let minimum=start??Infinity,maximum=end??start??-Infinity,previous=-Infinity;
    for(const childId of n.children){
      const child=bounds.get(childId);requireValue(child,'extent');
      requireValue(child.minimum>=previous,'extent');
      if(start!==undefined)requireValue(child.minimum>=start,'extent');
      if(end!==undefined)requireValue(child.maximum<=end,'extent');
      previous=Math.max(previous,child.maximum);
      minimum=Math.min(minimum,child.minimum);maximum=Math.max(maximum,child.maximum);
    }
    bounds.set(n.id,{minimum,maximum});
  }
}
// A full, bounded provider tree is retained once. Nodes refer to exact evidence
// paths/digests; unsupported fields never become textual stand-ins.
export function materialize({document,metadata,binding,reviewIncluded,budgets={}}) {
  const limits={...LIMITS,...budgets};boundedTree(document,limits);boundedTree(metadata,limits);boundedTree(binding,limits);
  requireValue(document.documentId===binding.documentId,'conflict');
  requireValue(['inline','acceptedPreview','rejectedPreview'].includes(binding.view));
  const providerView={inline:'SUGGESTIONS_INLINE',acceptedPreview:'PREVIEW_SUGGESTIONS_ACCEPTED',rejectedPreview:'PREVIEW_WITHOUT_SUGGESTIONS'}[binding.view];
  requireValue(document.suggestionsViewMode===providerView,'conflict');
  for(const key of ['snapshotId','subject','account','threadId','documentId'])requireValue(typeof binding[key]==='string'&&binding[key].length>0);
  const topologySlots=topologyBudget(document,limits),sizes=new WeakMap();
  let modelReservationBytes=0;
  function reserve(bytes){
    requireValue(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=limits.modelBytes-modelReservationBytes,'budget');
    modelReservationBytes+=bytes;
  }
  const size=value=>jsonBytes(value,limits.modelBytes,sizes);
  function resolvedStyle(explicit={},named={},source,normal={},type='text'){
    for(const value of [explicit,named,normal])requireValue(value&&typeof value==='object'&&!Array.isArray(value),'invalid');
    reserve(2048+64*(size(explicit)+size(named)+size(normal))+Object.keys(named).length*size(source??null));
    return styleEvidence(explicit,named,source,normal,type);
  }
  function tableInheritance(style,parent){
    let ancestor=nodes[parent];
    while(ancestor&&ancestor.kind!=='table')ancestor=nodes[ancestor.parent];
    if(!ancestor)return;
    // Docs documents possible table-style parenting but this read schema does
    // not supply a text/paragraph table default. Named values are candidates,
    // not fabricated effective values in that context; direct overrides stand.
    const inherited=Object.keys(style.properties).filter(key=>style.properties[key].provenance==='named');
    if(!inherited.length)return;
    reserve(1024+4*size(inherited));
    style.inheritanceContext={table:ancestor.id,effectiveParent:'notProvided'};
    for(const key of inherited)style.propertyEvidence[key].effectiveStatus='unknownTableParent';
  }
  // Conservative derived-model reservation, separate from SQLite capacity and
  // V8 heap usage. Charge repeated values before creating their derived copies.
  reserve(4096+4*(size(document)+size(metadata)+size(binding)));
  reserve(topologySlots*(size(binding.snapshotId)+32));
  const evidence=structuredClone(document), nodes=Object.create(null), tabs=[], outline=[], unknownFields=[];
  let count=0;let unresolvedExtents=false;
  const sectionHistory=new Map();
  function track(raw,path,known){
    for(const field of Object.keys(raw))if(!known.includes(field)){
      reserve(512+2*(size(path)+size(field)));
      unknownFields.push({path,field,digest:digest(raw[field])});
    }
  }
  // Gaps account for structural delimiters/newlines. Equality at boundaries is
  // legal; neither physical rows nor cells overlap just because a cell spans
  // visual rows. Unknown extents are not inferred from their children.
  function checkExtent(n,parent,previous=-1){
    if(!n.extent){n.extentStatus='unresolved';unresolvedExtents=true;return previous;}
    n.extentStatus='mapped';
    requireValue(n.extent.start>=previous,'extent');
    let ancestor=nodes[parent];
    while(ancestor){
      if(ancestor.extent)requireValue(n.extent.start>=ancestor.extent.start&&n.extent.end<=ancestor.extent.end,'extent');
      ancestor=nodes[ancestor.parent];
    }
    return n.extent.end;
  }
  function add(kind,raw,path,parent,tabId,segment,extra={}) {
    requireValue(++count<=limits.nodes,'budget');
    reserve(2048+10*size(binding.snapshotId)+16*(size(raw)+size(path)+size(extra))+4*(size(tabId)+size(segment)));
    const id=`${binding.snapshotId}:${count}`;
    let extent=null;
    if(raw.startIndex!==undefined)requireValue(Number.isSafeInteger(raw.startIndex)&&raw.startIndex>=0,'extent');
    if(raw.endIndex!==undefined){const start=raw.startIndex??0,end=raw.endIndex;requireValue(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>=start,'extent');extent={start,end};}
    const n={id,kind,parent,tabId,segment,extent,evidence:{path,digest:digest(raw)},children:[],...extra};nodes[id]=n;return n;
  }
  const review=raw=>Object.fromEntries(Object.entries(raw).filter(([k])=>reviewFields.includes(k)));
  function sequence(content,path,parent,tab,segment,depth) {
    requireValue(depth<=limits.depth,'budget');requireValue(Array.isArray(content));let previous=-1;
    const result=content.map((raw,i)=>{
      requireValue(raw&&typeof raw==='object'&&!Array.isArray(raw));
      const p=[...path,i], known=blockKinds.filter(k=>raw[k]!==undefined);requireValue(known.length<=1);
      const providerKind=known[0],kind=providerKind==='tableOfContents'?'toc':providerKind??'opaque';
      const n=add(kind,raw,p,parent,tab.providerId,segment,{review:review(raw)});
      previous=checkExtent(n,parent,previous);
      track(raw,p,['startIndex','endIndex',...blockKinds]);
      if(!providerKind){n.opaqueType=Object.keys(raw).filter(k=>!['startIndex','endIndex'].includes(k)).join(',')||'unknown';return n.id;}
      const value=raw[providerKind];requireValue(value&&typeof value==='object'&&!Array.isArray(value));
      n.review={...n.review,...review(value)};
      if(kind==='paragraph') {
        const ps=value.paragraphStyle??{}, namedType=ps.namedStyleType;
        const named=tab.namedStyleIndex.get(namedType);
        const normal=named&&namedType!=='NORMAL_TEXT'&&namedType!=='NAMED_STYLE_TYPE_UNSPECIFIED'?tab.namedStyleIndex.get('NORMAL_TEXT'):undefined;
        n.style=resolvedStyle(ps,named?.paragraphStyle,namedType,normal?.paragraphStyle,'paragraph');
        if(namedType&&!named)n.style.missingNamedStyle=namedType;
        tableInheritance(n.style,parent);
        n.list=value.bullet??null;n.positionedObjectIds=value.positionedObjectIds??[];
        n.review={...n.review,...review(value)};
        requireValue(Array.isArray(value.elements));let last=n.extent?.start??-1;
        n.children=value.elements.map((el,j)=>{
          requireValue(el&&typeof el==='object'&&!Array.isArray(el));const kinds=inlineKinds.filter(k=>el[k]!==undefined);requireValue(kinds.length<=1);
          const type=kinds[0];
          if(type)requireValue(el[type]&&typeof el[type]==='object'&&!Array.isArray(el[type]),'invalid');
          const inline=add(type==='textRun'?'text':type??'opaqueInline',el,[...p,'paragraph','elements',j],n.id,tab.providerId,segment,{review:review(el)});
          last=checkExtent(inline,n.id,last);
          if(type==='textRun'){
            inline.text=scalar(el.textRun.content);requireValue(inline.extent&&inline.extent.end-inline.extent.start===inline.text.length,'extent');
            inline.style=resolvedStyle(el.textRun.textStyle,named?.textStyle,namedType,normal?.textStyle);
            if(namedType&&!named)inline.style.missingNamedStyle=namedType;
            tableInheritance(inline.style,n.id);
            inline.review={...inline.review,...review(el.textRun)};
            track(el.textRun,[...inline.evidence.path,'textRun'],['content','textStyle','suggestedInsertionIds','suggestedDeletionIds','suggestedTextStyleChanges']);
          }else {
            inline.properties=type?Object.fromEntries(Object.entries(el[type]).filter(([key])=>(key!=='textStyle'||!textStyleKinds.has(type))&&!reviewFields.includes(key))):null;
            if(textStyleKinds.has(type)){
              inline.style=resolvedStyle(el[type].textStyle,named?.textStyle,namedType,normal?.textStyle);
              if(namedType&&!named)inline.style.missingNamedStyle=namedType;
              tableInheritance(inline.style,n.id);
            }
            if(type)inline.review={...inline.review,...review(el[type])};
            inline.opaqueType=type??Object.keys(el).filter(k=>!['startIndex','endIndex'].includes(k)).join(',');
            if(type==='inlineObjectElement'){
              const object=tab.registries.inlineObjects?.[el.inlineObjectElement.inlineObjectId]?.inlineObjectProperties?.embeddedObject;
              inline.objectKind=object?.imageProperties?'image':object?.linkedContentReference?.sheetsChartReference?'chart':'unknown';
            }
          }
          track(el,inline.evidence.path,['startIndex','endIndex',...inlineKinds,'suggestedInsertionIds','suggestedDeletionIds']);return inline.id;
        });
        track(value,[...p,'paragraph'],['elements','paragraphStyle','bullet','positionedObjectIds','suggestedParagraphStyleChanges','suggestedBulletChanges','suggestedPositionedObjectIds']);
        if(ps.headingId&&/^HEADING_[1-6]$/.test(namedType??'')){
          reserve(1024+4*(size(binding.documentId)+size(tab.providerId)+size(ps.headingId)));
          outline.push({providerId:ps.headingId,node:n.id,tabId:tab.providerId,segment,level:Number(namedType.at(-1)),
            title:n.children.map(id=>nodes[id].text??'').join('').replace(/\n$/,''),extent:n.extent,
            link:`https://docs.google.com/document/d/${encodeURIComponent(binding.documentId)}/edit?tab=${encodeURIComponent(tab.providerId)}#heading=${encodeURIComponent(ps.headingId)}`});
        }
      }else if(kind==='table'){
        requireValue(Array.isArray(value.tableRows));const rows=value.rows,columns=value.columns;
        requireValue(value.tableRows.length===rows,'extent');
        n.review={...n.review,...review(value)};
        n.grid=Array.from({length:rows},()=>Array(columns).fill(null));n.style=value.tableStyle??{};
        let previousRow=-1;
        n.children=value.tableRows.map((row,r)=>{
          const rn=add('tableRow',row,[...p,'table','tableRows',r],n.id,tab.providerId,segment,{style:row.tableRowStyle??{},review:review(row)});
          previousRow=checkExtent(rn,n.id,previousRow);
          track(row,rn.evidence.path,['startIndex','endIndex','tableCells','tableRowStyle','suggestedInsertionIds','suggestedDeletionIds','suggestedTableRowStyleChanges']);
          requireValue(Array.isArray(row.tableCells));let column=0,previousCell=-1;
          rn.children=row.tableCells.map((cell,c)=>{
            while(column<columns&&n.grid[r][column])column++;
            const cs=cell.tableCellStyle??{},rowSpan=cs.rowSpan??1,columnSpan=cs.columnSpan??1;
            requireValue(Number.isSafeInteger(rowSpan)&&rowSpan>0&&Number.isSafeInteger(columnSpan)&&columnSpan>0&&r+rowSpan<=rows&&column+columnSpan<=columns,'extent');
            const cn=add('tableCell',cell,[...rn.evidence.path,'tableCells',c],rn.id,tab.providerId,segment,{origin:{row:r,column},rowSpan,columnSpan,style:cs,review:review(cell)});
            previousCell=checkExtent(cn,rn.id,previousCell);
            track(cell,cn.evidence.path,['startIndex','endIndex','content','tableCellStyle','suggestedInsertionIds','suggestedDeletionIds','suggestedTableCellStyleChanges']);
            for(let y=r;y<r+rowSpan;y++)for(let x=column;x<column+columnSpan;x++){requireValue(n.grid[y][x]===null,'extent');n.grid[y][x]=cn.id;}
            cn.children=sequence(cell.content,[...cn.evidence.path,'content'],cn.id,tab,segment,depth+1);column+=columnSpan;return cn.id;
          });return rn.id;
        });requireValue(n.grid.every(row=>row.every(Boolean)),'extent');
        track(value,[...p,'table'],['rows','columns','tableRows','tableStyle','suggestedInsertionIds','suggestedDeletionIds']);
      }else if(kind==='toc') {
        n.children=sequence(value.content,[...p,'tableOfContents','content'],n.id,tab,segment,depth+1);
        track(value,[...p,'tableOfContents'],['content','suggestedInsertionIds','suggestedDeletionIds']);
      }else {
        const stored=value.sectionStyle??{};
        const nativeBody=segment.kind==='body'&&nodes[parent]?.kind==='segment';
        const previous=nativeBody?sectionHistory.get(tab.providerId):undefined;
        const documentStyle=nativeBody?tab.documentStyle?.stored??{}:{};
        reserve(2048+64*(size(stored)+size(documentStyle)+size(previous?.style.properties??{})));
        n.style=sectionStyleEvidence(stored,documentStyle,previous);
        if(nativeBody)sectionHistory.set(tab.providerId,n);
        track(value,[...p,'sectionBreak'],['sectionStyle','suggestedInsertionIds','suggestedDeletionIds']);
      }
      return n.id;
    });return result;
  }
  const ids=new Set();
  function tabTree(items,path,parent=null,depth=0) {
    requireValue(depth<=limits.depth&&Array.isArray(items),'budget');
    for(let i=0;i<items.length;i++){
      const raw=items[i],p=[...path,i],props=raw.tabProperties;requireValue(props&&typeof props.tabId==='string'&&props.tabId&&!ids.has(props.tabId));ids.add(props.tabId);
      requireValue(!props.parentTabId||props.parentTabId===parent,'conflict');requireValue(raw.documentTab&&typeof raw.documentTab==='object','unavailable');
      requireValue(typeof props.title==='string','invalid');
      if(props.nestingLevel!==undefined)requireValue(props.nestingLevel===depth,'conflict');
      if(props.index!==undefined)requireValue(Number.isSafeInteger(props.index)&&props.index>=0,'invalid');
      const body=raw.documentTab,tab={providerId:props.tabId,title:props.title,parent,ordinal:tabs.length,siblingIndex:props.index??i,depth,properties:props,segments:[],registries:Object.create(null)};
      reserve(2048+4*(size(props)+size(body)));
      for(const key of registryNames)tab.registries[key]=body[key]??null;
      tab.evidencePath=[...p,'documentTab'];
      if(body.documentStyle)reserve(2048+64*size(body.documentStyle));
      tab.documentStyle=body.documentStyle?documentStyleEvidence(body.documentStyle):null;
      tab.namedStyleIndex=new Map();
      if(body.namedStyles){
        requireValue(Array.isArray(body.namedStyles.styles),'invalid');
        for(const style of body.namedStyles.styles){
          requireValue(style&&typeof style.namedStyleType==='string'&&!tab.namedStyleIndex.has(style.namedStyleType),'invalid');
          tab.namedStyleIndex.set(style.namedStyleType,style);
        }
      }
      tabs.push(tab);
      const segment=(kind,id,value,sp)=>{requireValue(value&&Array.isArray(value.content),'unavailable');const s={kind,...(id?{id}:{})},sn=add('segment',value,sp,null,tab.providerId,s);
        track(value,sp,['content','headerId','footerId','footnoteId']);
        tab.segments.push(sn.id);sn.children=sequence(value.content,[...sp,'content'],sn.id,tab,s,0);};
      segment('body',null,body.body,[...p,'documentTab','body']);
      for(const [key,kind]of [['headers','header'],['footers','footer'],['footnotes','footnote']])for(const [id,value]of Object.entries(body[key]??{}))segment(kind,id,value,[...p,'documentTab',key,id]);
      track(body,[...p,'documentTab'],['body','headers','footers','footnotes',...registryNames,'documentStyle','suggestedDocumentStyleChanges']);
      track(raw,p,['tabProperties','documentTab','childTabs']);
      delete tab.namedStyleIndex;
      if(raw.childTabs)tabTree(raw.childTabs,[...p,'childTabs'],tab.providerId,depth+1);
    }
  }
  requireValue(Array.isArray(evidence.tabs)&&evidence.tabs.length>0,'unavailable');tabTree(evidence.tabs,['tabs']);
  // A missing end does not erase the constraints supplied by a known start,
  // descendants, or ordered siblings. Validate their joint consistency before
  // any raw start can be used as a disjointness bound. These temporary bounds
  // summarize known facts only: they never become an inferred node extent.
  validateStructuralFacts({nodes,evidence});
  // Heading ancestry and peer boundaries are segment-local, including nested
  // structures; no coordinates or numeric arithmetic cross a segment.
  const key=n=>JSON.stringify([n.tabId,n.segment]),ends=new Map(),segments=new Map(),groups=new Map();
  for(const n of Object.values(nodes)){
    if(n.extent)ends.set(key(n),Math.max(ends.get(key(n))??0,n.extent.end));
    if(n.kind==='segment')segments.set(key(n),n);
  }
  for(const h of outline){const k=key(h);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(h);}
  for(const [k,hs]of groups){const ancestry=[],peers=[];
    for(const h of hs){while(ancestry.length&&ancestry.at(-1).level>=h.level)ancestry.pop();reserve(1024+4*(size(h.title)+ancestry.reduce((sum,x)=>sum+size(x.title),0)));h.path=[...ancestry.map(x=>x.title),h.title];h.depth=ancestry.length;ancestry.push(h);}
    for(let i=hs.length-1;i>=0;i--){const h=hs[i];while(peers.length&&peers.at(-1).level>h.level)peers.pop();
      const next=peers.at(-1),segment=segments.get(k),last=nodes[segment.children.at(-1)];
      const segmentEnd=segment.extent?.end??last?.extent?.end;
      h.sectionEnd=next?.extent?{kind:'nextHeading',node:next.node}:segmentEnd!==undefined?{kind:'segmentBoundary',node:segment.extent?segment.id:last.id}:{kind:'observedMaximum'};
      h.extent=h.extent?{start:h.extent.start,end:next?.extent?.start??segmentEnd??ends.get(k)??0}:null;peers.push(h);}
  }
  const registries={comments:evidence.comments??null,suggestions:evidence.suggestions??null,documentStyle:evidence.documentStyle??null,suggestedNamedStylesChanges:evidence.suggestedNamedStylesChanges??null};
  requireValue(registries.comments===null||Array.isArray(registries.comments),'invalid');
  requireValue(registries.suggestions===null||Array.isArray(registries.suggestions),'invalid');
  const missingReviewCoverage=!reviewIncluded||evidence.commentsViewMode!=='COMMENTS_VIEW_MODE_INCLUDED';
  const anchorsByTab=new Map(tabs.map(t=>[t.providerId,Object.values(t.registries.commentAnchors??{})]));
  for(const anchors of anchorsByTab.values())for(const anchor of anchors){
    requireValue(anchor&&typeof anchor.anchorId==='string'&&Array.isArray(anchor.ranges),'invalid');
    for(const range of anchor.ranges)requireValue(range&&Number.isSafeInteger(range.startIndex??0)&&Number.isSafeInteger(range.endIndex)&&(range.startIndex??0)>=0&&range.endIndex>=(range.startIndex??0),'extent');
  }
  const threadsByAnchor=new Map();
  for(const thread of registries.comments??[]){requireValue(thread&&typeof thread.commentId==='string','invalid');if(!threadsByAnchor.has(thread.anchorId))threadsByAnchor.set(thread.anchorId,[]);threadsByAnchor.get(thread.anchorId).push(thread);}
  let reviewComparisons=0;
  for(const n of Object.values(nodes))if(n.extent&&n.kind!=='segment'){
    const comments=[];
    for(const anchor of anchorsByTab.get(n.tabId)??[])for(const range of anchor.ranges??[]){
      requireValue(++reviewComparisons<=limits.reviewComparisons,'budget');
      if((!range.tabId||range.tabId===n.tabId)&&(range.segmentId??null)===(n.segment.id??null)&&Number.isSafeInteger(range.endIndex)&&
        (range.startIndex??0)<n.extent.end&&range.endIndex>n.extent.start){
        const threads=threadsByAnchor.get(anchor.anchorId)??[];
        reserve(4*size(threads));
        comments.push(...threads);
      }
    }
    if(comments.length)n.review={...n.review,comments:[...new Map(comments.map(c=>[c.commentId,c])).values()]};
  }
  track(evidence,[],['comments','suggestions','commentsViewMode','suggestedNamedStylesChanges','documentId','title','revisionId','suggestionsViewMode','tabs','documentStyle','namedStyles','body','headers','footers','footnotes','lists','inlineObjects','positionedObjects','namedRanges','suggestedDocumentStyleChanges']);
  // Attribute an unprojected field to its nearest semantic owner, not every
  // sibling in the document. Nested paths are resolved structurally, not by a
  // magic field name. Opaque records already deliver their complete raw value.
  const nodePaths=new Map(Object.values(nodes).map(n=>[JSON.stringify(n.evidence.path),n]));
  for(const field of unknownFields){
    const path=[...field.path];let owner;
    while(path.length&&!owner){owner=nodePaths.get(JSON.stringify(path));if(!owner)path.pop();}
    if(owner&&!owner.kind.startsWith('opaque')){
      reserve(512+2*size(field));
      (owner.unprojectedFields??=[]).push(field);
    }
  }
  // Registry definitions are separate identities, never substitute content
  // nodes. Reference records join observed IDs without treating key counts as
  // delivery. All expanded records are charged before construction.
  const registryEntries=[],registryReferences=[],registryIndex=new Map();
  function registryEntry(kind,category,tabId,providerId,path,value){
    requireValue(registryEntries.length<limits.nodes,'budget');
    reserve(2048+8*(size(path)+size(value)+size(providerId??null)+size(tabId)));
    const entry={id:`${binding.snapshotId}:registry:${registryEntries.length+1}`,kind,category,tabId,providerId:providerId??null,
      evidence:{path,digest:digest(value)},value,diagnosticOnly:true,
      definitionStatus:value&&typeof value==='object'&&!Array.isArray(value)?'observed':'unknownShape'};
    registryEntries.push(entry);
    const key=JSON.stringify([tabId,kind,providerId]);
    if(!registryIndex.has(key))registryIndex.set(key,[]);
    if(entry.definitionStatus==='observed')registryIndex.get(key).push(entry.id);
    return entry;
  }
  for(const tab of tabs){
    const path=tab.evidencePath,body=path.reduce((v,k)=>v[k],evidence);
    const normal=body.namedStyles?.styles?.find(s=>s.namedStyleType==='NORMAL_TEXT');
    for(const [i,style] of (body.namedStyles?.styles??[]).entries()){
      const entry=registryEntry('namedStyle','styles',tab.providerId,style.namedStyleType,[...path,'namedStyles','styles',i],style);
      entry.styles={text:resolvedStyle(style.textStyle,{},undefined,style.namedStyleType==='NORMAL_TEXT'?{}:normal?.textStyle),
        paragraph:resolvedStyle(style.paragraphStyle,{},undefined,style.namedStyleType==='NORMAL_TEXT'?{}:normal?.paragraphStyle,'paragraph')};
    }
    for(const [key,kind,category] of [['lists','listDefinition','lists'],['inlineObjects','inlineObjectDefinition','objects'],['positionedObjects','positionedObjectDefinition','objects'],['dropdownDefinitions','dropdownDefinition','objects'],['commentAnchors','commentAnchor','review'],['suggestedDocumentStyleChanges','suggestedDocumentStyle','review'],['suggestedNamedStylesChanges','suggestedNamedStyles','review']]){
      const dictionary=body[key]??{};
      requireValue(dictionary&&typeof dictionary==='object'&&!Array.isArray(dictionary),'invalid');
      for(const [id,value] of Object.entries(dictionary))registryEntry(kind,category,tab.providerId,id,[...path,key,id],value);
    }
    for(const [name,group] of Object.entries(body.namedRanges??{})){
      requireValue(group&&Array.isArray(group.namedRanges),'invalid');
      reserve(1024+4*size(group));
      const groupProperties=Object.fromEntries(Object.entries(group).filter(([key])=>key!=='namedRanges'));
      for(const [i,range] of group.namedRanges.entries()){
        requireValue(range&&typeof range.namedRangeId==='string'&&Array.isArray(range.ranges),'invalid');
        reserve(1024+8*(size(name)+size(groupProperties)));
        const entry=registryEntry('namedRange','ranges',tab.providerId,range.namedRangeId,[...path,'namedRanges',name,'namedRanges',i],range);
        entry.groupKey=name;entry.groupProperties=groupProperties;
      }
    }
    if(body.documentStyle)registryEntry('documentStyle','styles',tab.providerId,null,[...path,'documentStyle'],body.documentStyle).style=tab.documentStyle;
  }
  for(const [key,kind,idKey] of [['comments','commentThread','commentId'],['suggestions','suggestionThread','suggestionId']]){
    for(const [i,value] of (evidence[key]??[]).entries())registryEntry(kind,'review',null,value[idKey],[key,i],value);
  }
  function reference(node,kind,category,providerId,field,global=false,dependencyOwner){
    if(providerId===undefined||providerId===null)return;
    requireValue(typeof providerId==='string'&&registryReferences.length<limits.nodes,'invalid');
    const targets=registryIndex.get(JSON.stringify([global?null:node.tabId,kind,providerId]))??[];
    reserve(2048+8*(size(providerId)+size(node.id)+size(targets)+size(field)+size(dependencyOwner?.id??null)));
    registryReferences.push({id:`${binding.snapshotId}:reference:${registryReferences.length+1}`,kind:'registryReference',category,
      ownerNode:node.id,tabId:node.tabId,segment:node.segment,providerId,definitionKind:kind,targets,
      status:targets.length===1?'resolved':targets.length?'ambiguous':'unresolved',field,evidenceDigest:node.evidence.digest,
      ...(dependencyOwner?{dependencyOwner:dependencyOwner.id,dependencyEvidenceDigest:dependencyOwner.evidence.digest}:{})});
  }
  for(const node of Object.values(nodes)){
    if(node.kind==='paragraph'){
      reference(node,'namedStyle','styles',node.style.explicit.namedStyleType,'paragraphStyle.namedStyleType');
      if(node.style.explicit.namedStyleType&&node.style.explicit.namedStyleType!=='NORMAL_TEXT'&&!node.style.missingNamedStyle)
        reference(node,'namedStyle','styles','NORMAL_TEXT','inheritedNormalStyle');
      reference(node,'listDefinition','lists',node.list?.listId,'bullet.listId');
      for(const id of node.positionedObjectIds)reference(node,'positionedObjectDefinition','objects',id,'positionedObjectIds');
    }
    const paragraph=nodes[node.parent];
    if(node.style&&paragraph?.kind==='paragraph'){
      // Only style dependencies transfer to this descendant's diagnostics.
      // The parent, siblings, lists, objects and review do not become selected.
      const namedType=paragraph.style.explicit.namedStyleType;
      reference(node,'namedStyle','styles',namedType,'parentParagraph.namedStyleType',false,paragraph);
      if(namedType&&namedType!=='NORMAL_TEXT'&&namedType!=='NAMED_STYLE_TYPE_UNSPECIFIED'&&!paragraph.style.missingNamedStyle)
        reference(node,'namedStyle','styles','NORMAL_TEXT','inheritedNormalStyle',false,paragraph);
    }
    if(node.kind==='inlineObjectElement')reference(node,'inlineObjectDefinition','objects',node.properties.inlineObjectId,'inlineObjectId');
    if(node.kind==='dropdown')reference(node,'dropdownDefinition','objects',node.properties.dropdownProperties?.dropdownDefinitionId,'dropdownProperties.dropdownDefinitionId');
    for(const [field,value] of Object.entries(node.review??{})){
      if(field==='comments')for(const comment of value)reference(node,'commentThread','review',comment.commentId,field,true);
      else if(field==='commentIds')for(const id of value)reference(node,'commentThread','review',id,field,true);
      else if(field.startsWith('suggested'))for(const id of Array.isArray(value)?value:Object.keys(value??{}))reference(node,'suggestionThread','review',id,field,true);
    }
  }
  const revision=typeof evidence.revisionId==='string'&&evidence.revisionId?{kind:'docs',id:evidence.revisionId,subject:binding.subject}:{kind:'unavailable',reason:'notProvided'};
  const result={version:1,binding:{...binding},metadata:structuredClone(metadata),evidence,evidenceDigest:digest(evidence),nodes,tabs,outline,unknownFields,registries,registryEntries,registryReferences,revision,
    currentEditEvidence:binding.view==='inline'&&revision.kind==='docs',missingReviewCoverage,materialized:'complete',
    unresolvedExtents,resources:{topologySlots,modelReservationBytes,modelByteLimit:limits.modelBytes}};
  // Defense in depth before freezing/storage serialization. The reservations
  // above, not this final measurement, bound allocation of expanded structures.
  jsonBytes(result,modelReservationBytes);
  return freeze(result);
}
