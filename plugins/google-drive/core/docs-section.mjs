// One native heading's plain prose. Pure selection, wire compilation and
// independent readback; no host, storage or Google dependency.
import {inspectLiteralDocument, style, updatedPieces, knownTextParent, bodyWalk, stableObservations} from './docs-literal.mjs';
const fail = (docsCode = 'unsupported_section') => { throw Object.assign(new Error('Docs section '+docsCode), {docsCode}); };
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
const same = (a,b) => canonical(a) === canonical(b);
const plain = s => typeof s === 'string' && s.isWellFormed() && !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\uE000-\uF8FF\u2028\u2029]/u.test(s);
function validate(args) {
  if (!plain(args.heading) || !args.heading.trim() || args.heading.length > 256 || args.heading.includes('\n') || !plain(args.newText) || !args.newText.length || args.newText.length > 2000 || args.newText.split('\n').some(line => !line.trim()) || typeof args.tabId !== 'string' || !args.tabId || args.tabId.length > 256 || typeof args.expectedRevisionId !== 'string' || !args.expectedRevisionId || args.expectedRevisionId.length > 2048 || (args.preview !== undefined && typeof args.preview !== 'boolean')) fail('invalid_section_input');
}
// Direction is documented as non-inherited, default LEFT_TO_RIGHT. Only this
// absent/explicit equivalence is accepted, and only on the replaced body.
function normalParagraphStyle(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['namedStyleType','direction'].includes(k)) || ('namedStyleType' in value && value.namedStyleType !== 'NORMAL_TEXT') || ('direction' in value && value.direction !== 'LEFT_TO_RIGHT')) fail();
  return {...value,direction:'LEFT_TO_RIGHT'};
}
const headingLevel = item => /^HEADING_[1-6]$/.test(item.paragraph?.paragraphStyle?.namedStyleType ?? '') ? Number(item.paragraph.paragraphStyle.namedStyleType.at(-1)) : null;
const visible = item => item.paragraph?.elements?.map(p => p.textRun?.content ?? '\uFFFC').join('').replace(/\n$/, '');
export function selectSection(snapshot,args) {
  validate(args);
  if (snapshot.revisionId !== args.expectedRevisionId) fail('stale_revision');
  const tab = snapshot.tabs.find(t => t.tabId === args.tabId);
  if (!tab) fail('heading_not_unique');
  const content = tab.data.body.content;
  let headingMatches = 0;
  bodyWalk(content,item => { if (headingLevel(item) && visible(item) === args.heading) headingMatches++; });
  if (headingMatches !== 1) fail('heading_not_unique');
  const matches = content.map((item,index) => headingLevel(item) && visible(item) === args.heading ? index : -1).filter(i => i >= 0);
  if (matches.length !== 1) fail('heading_not_unique');
  const headingIndex = matches[0], level = headingLevel(content[headingIndex]);
  let stop = headingIndex + 1;
  while (stop < content.length && !(headingLevel(content[stop]) && headingLevel(content[stop]) <= level)) stop++;
  const first = headingIndex + 1, body = content.slice(first,stop);
  if (!body.length) fail();
  // The first profile accepts only NORMAL_TEXT (or inherited normal) paragraph
  // styles, all identical, and compatible direct text styles throughout.
  const paragraphStyle = normalParagraphStyle(body[0].paragraph?.paragraphStyle);
  let textStyle, oldText = '', end = body[0].startIndex;
  for (const item of body) {
    const p = item.paragraph;
    if (!p || item.startIndex !== end || Object.keys(p).some(k => !['elements','paragraphStyle'].includes(k)) || !same(normalParagraphStyle(p.paragraphStyle),paragraphStyle)) fail();
    let paragraphText = '';
    for (const part of p.elements) {
      if (Object.keys(part).some(k => !['startIndex','endIndex','textRun'].includes(k)) || !part.textRun || Object.keys(part.textRun).some(k => !['content','textStyle'].includes(k))) fail();
      try { style(part.textRun.textStyle); } catch { fail(); }
      const current = part.textRun.textStyle ?? {};
      if (textStyle === undefined) textStyle = current;
      if (!same(textStyle,current)) fail();
      paragraphText += part.textRun.content;
    }
    if (!plain(paragraphText) || !paragraphText.endsWith('\n') || paragraphText.slice(0,-1).includes('\n') || !paragraphText.trim()) fail();
    oldText += paragraphText; end = item.endIndex;
  }
  oldText = oldText.slice(0,-1); // retain final original newline, even at tab end
  if (oldText.length > 2000 || oldText === args.newText) fail('invalid_section_input');
  if (snapshot.tabs.reduce((n,t) => n+t.text.length,0)-oldText.length+args.newText.length > 50000) fail('invalid_section_input');
  // Registries carry offsets outside body nodes; no guessed transformation.
  for (const owner of [snapshot.raw,tab.data]) for (const key of ['namedRanges','bookmarks','commentAnchors']) if (Object.keys(owner[key] ?? {}).length) fail();
  if (Object.keys(tab.data).some(k => !['body','headers','footers','footnotes','inlineObjects','positionedObjects','documentStyle','namedStyles','lists','namedRanges','suggestedDocumentStyleChanges','suggestedNamedStylesChanges','commentAnchors','dropdownDefinitions'].includes(k)) || Object.keys(tab.data.body).some(k => k !== 'content')) fail();
  return {tab,first,stop,oldText,startIndex:body[0].startIndex,endIndex:end-1,paragraphStyle,textStyle};
}
export function planSectionEdit(snapshot,args) {
  const t = selectSection(snapshot,args);
  const plan = {profile:'heading-prose/1',documentId:snapshot.documentId,tabId:args.tabId,expectedRevisionId:args.expectedRevisionId,heading:args.heading,oldText:t.oldText,newText:args.newText,startIndex:t.startIndex,endIndex:t.endIndex,textStyle:structuredClone(t.textStyle),paragraphStyle:structuredClone(t.paragraphStyle)};
  sectionRequests(plan); return plan;
}
export function sectionRequests(plan) {
  validate(plan);
  if (plan.profile !== 'heading-prose/1' || !Number.isSafeInteger(plan.startIndex) || plan.startIndex < 1 || !plain(plan.oldText) || !plan.oldText.length || plan.oldText.length > 2000 || plan.endIndex !== plan.startIndex+plan.oldText.length) fail('invalid_section_input');
  style(plan.textStyle);
  if (!plan.paragraphStyle) fail();
  const paragraphStyle = normalParagraphStyle(plan.paragraphStyle);
  const range = {tabId:plan.tabId,startIndex:plan.startIndex,endIndex:plan.endIndex};
  return [{deleteContentRange:{range}}, {insertText:{location:{tabId:plan.tabId,index:plan.startIndex},text:plan.newText}},
    {updateTextStyle:{range:{...range,endIndex:plan.startIndex+plan.newText.length+1},textStyle:plan.textStyle,fields:'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link'}},
    {updateParagraphStyle:{range:{...range,endIndex:plan.startIndex+plan.newText.length+1},paragraphStyle,fields:'namedStyleType,direction'}}];
}
export function sectionReadbackMatches(before,after,args) {
  try {
    const source = inspectLiteralDocument(before,before.documentId), t = selectSection(source,args);
    inspectLiteralDocument(after,before.documentId); // structural/UTF-16 validation
    const [left,right] = stableObservations(before,after);
    if (!right.revisionId || typeof right.revisionId !== 'string') return false;
    const find = doc => { let data; function visit(tabs) { for (const tab of tabs) { if (tab.tabProperties.tabId === args.tabId) data = tab.documentTab; if (tab.childTabs) visit(tab.childTabs); } } visit(doc.tabs); return data; };
    const a = find(left).body.content, b = find(right).body.content;
    const lines = args.newText.split('\n'), count = t.stop-t.first;
    if (b.length !== a.length-count+lines.length) return false;
    let index = t.startIndex;
    for (let i=0;i<lines.length;i++) {
      const item = b[t.first+i], text = lines[i]+'\n', end = index+text.length;
      if (!item || item.startIndex !== index || item.endIndex !== end || Object.keys(item).some(k => !['startIndex','endIndex','paragraph'].includes(k)) || !item.paragraph || Object.keys(item.paragraph).some(k => !['elements','paragraphStyle'].includes(k)) || !same(normalParagraphStyle(item.paragraph.paragraphStyle),t.paragraphStyle)) return false;
      // Independent expected line/style comparison, not compiler output.
      const parent = knownTextParent(t.tab.data,{paragraphStyle:t.paragraphStyle});
      if (!same(updatedPieces(item.paragraph.elements,index,end,index,end,parent),updatedPieces([{startIndex:index,endIndex:end,textRun:{content:text,textStyle:t.textStyle}}],index,end,index,end,parent))) return false;
      index = end;
    }
    a.splice(t.first,count); b.splice(t.first,lines.length);
    const delta = args.newText.length-t.oldText.length;
    const original = [], observed = [];
    bodyWalk(a,n => original.push(n)); bodyWalk(b,n => observed.push(n));
    if (original.length !== observed.length) return false;
    for (let i=0;i<original.length;i++) for (const key of ['startIndex','endIndex']) {
      const x = original[i], y = observed[i];
      if (!Object.hasOwn(x,key)) { if (Object.hasOwn(y,key)) return false; continue; }
      const shift = x[key] > t.endIndex ? delta : 0;
      if (y[key] !== x[key]+shift) return false;
      y[key] = x[key];
    }
    delete left.revisionId; delete right.revisionId;
    return same(left,right);
  } catch { return false; }
}
