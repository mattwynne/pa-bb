// Formatting only: whole body paragraphs, no insertion/deletion or raw requests.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { documentId, inspectDocument, rejectSuggestions, docsError, docsErrorMessage } from './docs-edit.mjs';
import { docsApprovalDecision, diagnoseDocsApproval } from './docs-approval.mjs';
import { pageFormat } from './docs-page-format.mjs';
const target = { account: z.string().min(1).max(320), document: z.string().min(1).max(1024) };
const nonempty = shape => z.object(shape).strict().refine(v => Object.keys(v).length > 0);
export const textFormat = nonempty({ fontFamily: z.string().regex(/^[A-Za-z][A-Za-z0-9 -]{0,79}$/).optional(),
  sizePt: z.number().min(6).max(72).optional(), bold: z.boolean().optional(),
  foregroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() });
export const paragraphFormat = nonempty({ spaceAbovePt: z.number().min(0).max(72).optional(),
  spaceBelowPt: z.number().min(0).max(72).optional(), lineSpacing: z.number().min(100).max(200).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-8, 'Use line-spacing percentages in 0.01 increments.').describe('Line spacing percentage from 100 to 200, in 0.01 increments; 120 means 1.2 lines.').optional(),
  alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional() });
export const formatInspectSchema = z.object({ ...target, mode: z.enum(['paragraphs', 'page']).default('paragraphs').describe('Use page for page-only formatting on bounded structured documents; paragraphs retains strict text-range inspection.') }).strict();
export const formatStatusSchema = z.object({ account: target.account, operationId: z.uuid().regex(/^[0-9a-f-]+$/) }).strict();
export const formatSchema = z.object({ ...target, operationId: formatStatusSchema.shape.operationId,
  expectedRevisionId: z.string().min(1).max(2048), preview: z.boolean().default(true),
  ranges: z.array(z.object({ tabId: z.string().min(1).max(256), startIndex: z.number().int().min(1), endIndex: z.number().int().min(2),
    textStyle: textFormat.optional(), paragraphStyle: paragraphFormat.optional() }).strict().refine(r => r.textStyle || r.paragraphStyle)).max(16).default([]),
  page: pageFormat.optional(),
}).strict().refine(v => v.page || v.ranges.length);
const messages = {
  invalid: 'Use inspected whole-paragraph UTF-16 ranges, a current revision and a single-use lowercase UUID. At most 16 nonoverlapping ranges and 8000 selected UTF-16 units are supported. No arbitrary Google API requests.',
  unsupported: 'Formatting requires a complete supported inspection. Paragraph ranges require simple paginated body paragraphs; page-only changes require an inspectable paged tab and complete bounded document. Suggestions or unverifiable page styles are rejected.',
  stale: 'The revision or exact inspected document changed. Nothing new was submitted. Inspect again and prepare a separately requested proposal.',
  approval_required: 'Docs approval was re-enabled before submission. No write was attempted. Prepare a fresh reviewed proposal.',
  conflict: 'This operationId belongs to another request/account. Recover the original operation; never replace a key to bypass uncertainty.',
  busy: 'Another formatting operation is reviewing, writing or unresolved on this document. Recover that operation before another proposal.',
  unknown_operation: 'No formatting receipt exists for this account/key. This is not proof that no external write occurred.',
};
export const formatError = code => Object.assign(new Error(messages[code] || 'Formatting is unavailable. Inspect the same operation; never replay an uncertain write.'), { formatCode: code });
export const formatCategory = error => Object.hasOwn(messages, error?.formatCode) ? error.formatCode : 'unknown';
export const formatMessage = error => (messages[error?.formatCode] || (error?.docsCode ? docsErrorMessage(error) : 'Formatting inspection or verification is unavailable. Recover using the SAME account and operationId; never replay or replace an uncertain write.'))
  + (error?.formatCode === 'busy' && formatStatusSchema.shape.operationId.safeParse(error.operationId).success ? ` Blocking operationId: ${error.operationId}. Use its original connected account.` : '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const pt = magnitude => ({ magnitude, unit: 'PT' });
const rgbRead = z.object({ red: z.number().min(0).max(1).optional(), green: z.number().min(0).max(1).optional(), blue: z.number().min(0).max(1).optional() }).strict();
const backgroundRead = z.object({ color: z.object({ color: z.object({ rgbColor: rgbRead.optional() }).strict().optional() }).strict().optional() }).strict().optional();
const rgb = hex => Object.fromEntries(['red', 'green', 'blue'].map((key, i) => [key, parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255]));
export function stylePatch(range) {
  const textStyle = {}, paragraphStyle = {};
  for (const [key, value] of Object.entries(range.textStyle || {})) {
    if (key === 'fontFamily') textStyle.weightedFontFamily = { fontFamily: value };
    if (key === 'sizePt') textStyle.fontSize = pt(value);
    if (key === 'bold') textStyle.bold = value;
    if (key === 'foregroundColor') textStyle.foregroundColor = { color: { rgbColor: rgb(value) } };
  }
  for (const [key, value] of Object.entries(range.paragraphStyle || {})) {
    if (key === 'spaceAbovePt') paragraphStyle.spaceAbove = pt(value);
    else if (key === 'spaceBelowPt') paragraphStyle.spaceBelow = pt(value);
    else paragraphStyle[key] = value;
  }
  return { textStyle, paragraphStyle };
}
export function formatRequests(args) {
  const requests = [];
  for (const r of args.ranges) {
    const range = { tabId: r.tabId, startIndex: r.startIndex, endIndex: r.endIndex };
    const patch = stylePatch(r);
    if (r.paragraphStyle) requests.push({ updateParagraphStyle: { range, paragraphStyle: patch.paragraphStyle, fields: Object.keys(patch.paragraphStyle).join(',') } });
    if (r.textStyle) requests.push({ updateTextStyle: { range, textStyle: patch.textStyle,
      fields: Object.keys(patch.textStyle).map(k => k === 'weightedFontFamily' ? 'weightedFontFamily.fontFamily' : k).join(',') } });
  }
  if (args.page) {
    const p = args.page;
    const documentStyle = {};
    if (p.size) documentStyle.pageSize = { width: pt(612), height: pt(792) };
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      if (p[`margin${side}Pt`] !== undefined) documentStyle[`margin${side}`] = pt(p[`margin${side}Pt`]);
    }
    // Background.color is OptionalColor, whose color is the RGB Color.
    if (p.backgroundColor) documentStyle.background = { color: { color: { rgbColor: rgb(p.backgroundColor) } } };
    requests.push({ updateDocumentStyle: { tabId: p.tabId, documentStyle, fields: Object.keys(documentStyle).join(',') } });
  }
  return requests;
}
function tabs(doc) {
  const result = [];
  const visit = nodes => { for (const tab of nodes) { result.push(tab); visit(tab.childTabs || []); } };
  visit(doc.tabs); return result;
}
// Normalize run splits, float serialization and known named-style inheritance.
// Missing editor defaults stay unknown: never guess a font or inherited value.
function inheritedText(tab, paragraph) {
  const named = tab.documentTab.namedStyles?.styles || [];
  const normal = named.find(n => n.namedStyleType === 'NORMAL_TEXT') || {};
  const parent = named.find(n => n.namedStyleType === paragraph.paragraphStyle?.namedStyleType) || normal;
  const inherited = { ...normal.textStyle, ...parent.textStyle };
  delete inherited.link; // Links never inherit in the Docs API.
  return inherited;
}
function normalized(value) {
  if (value && typeof value === 'object' && value.unit === 'PT' && value.magnitude === undefined) value = { magnitude: 0, ...value };
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalized(k === 'rgbColor' ? { red: 0, green: 0, blue: 0, ...value[k] } : value[k])]));
  return value;
}
function canonical(doc, ranges = []) {
  const copy = clone(doc); delete copy.revisionId;
  for (const tab of tabs(copy)) {
    const named = tab.documentTab.namedStyles?.styles || [];
    const normal = named.find(n => n.namedStyleType === 'NORMAL_TEXT') || {};
    for (const item of tab.documentTab.body.content) {
      if (!item.paragraph) continue;
      const parent = named.find(n => n.namedStyleType === item.paragraph.paragraphStyle?.namedStyleType) || normal;
      const selection = ranges.find(r => r.tabId === tab.tabProperties.tabId && item.startIndex >= r.startIndex && item.endIndex <= r.endIndex);
      const patch = stylePatch(selection || {});
      // Only selected properties may normalize from explicit to inherited.
      // Unrelated overrides stay exact, not just visually equivalent now.
      const paragraphStyle = { ...item.paragraph.paragraphStyle };
      const effectiveParagraph = { ...normal.paragraphStyle, ...parent.paragraphStyle, ...paragraphStyle };
      for (const key of Object.keys(patch.paragraphStyle)) {
        if (effectiveParagraph[key] !== undefined) paragraphStyle[key] = effectiveParagraph[key];
      }
      if (item.paragraph.paragraphStyle || Object.keys(paragraphStyle).length) item.paragraph.paragraphStyle = paragraphStyle;
      const runs = [];
      for (const element of item.paragraph.elements) {
        const style = { ...element.textRun.textStyle };
        const effective = { ...inheritedText(tab, item.paragraph), ...style };
        for (const key of Object.keys(patch.textStyle)) {
          if (effective[key] !== undefined) style[key] = effective[key];
        }
        if (patch.textStyle.weightedFontFamily && style.weightedFontFamily?.fontFamily && style.weightedFontFamily.weight === undefined) style.weightedFontFamily = { ...style.weightedFontFamily, weight: 400 };
        const normalizedStyle = normalized(style), previous = runs.at(-1);
        if (previous && isDeepStrictEqual(previous.style, normalizedStyle)) previous.text += element.textRun.content;
        else runs.push({ text: element.textRun.content, style: normalizedStyle });
      }
      item.paragraph.elements = runs;
    }
  }
  return normalized(copy);
}
// Docs exposes lineSpacing as float32. A requested human-scale percentage can
// return the adjacent float32 bin (e.g. 120 -> 120.00001). Accommodate only that
// selected field; never round all styles, named definitions or unrelated text.

// Page-only operations preserve the entire provider response, including opaque
// body structures. Validate the envelope independently of paragraph editability.
const pageStyleKeys = new Set(['background', 'pageSize', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHeader', 'marginFooter', 'flipPageOrientation', 'documentFormat', 'defaultHeaderId', 'defaultFooterId', 'firstPageHeaderId', 'firstPageFooterId', 'evenPageHeaderId', 'evenPageFooterId', 'useFirstPageHeaderFooter', 'useEvenPageHeaderFooter']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function inspectPageDocument(doc, id) {
  const fail = () => { throw formatError('unsupported'); };
  if (!object(doc) || doc.documentId !== id || typeof doc.revisionId !== 'string' || !doc.revisionId.length || doc.revisionId.length > 2048 || doc.suggestionsViewMode !== 'SUGGESTIONS_INLINE' || !Array.isArray(doc.tabs) || !doc.tabs.length || Buffer.byteLength(JSON.stringify(doc), 'utf8') > 1_048_576) fail();
  rejectSuggestions(doc);
  if (doc.documentStyle && Object.keys(doc.documentStyle).length) fail();
  const found = [], seen = new Set();
  let bodyUnits = 0;
  function structure(item, depth = 0) {
    if (depth > 32 || !object(item)) fail();
    const kinds = ['sectionBreak', 'paragraph', 'table', 'tableOfContents'].filter(k => Object.hasOwn(item, k));
    if (kinds.length !== 1 || !object(item[kinds[0]])) fail();
    if (item.paragraph) {
      if (!Array.isArray(item.paragraph.elements) || !item.paragraph.elements.length) fail();
      for (const e of item.paragraph.elements) {
        if (!object(e)) fail();
        const variants = ['textRun', 'autoText', 'pageBreak', 'columnBreak', 'footnoteReference', 'horizontalRule', 'equation', 'inlineObjectElement', 'person', 'richLink', 'dateElement'].filter(k => Object.hasOwn(e, k));
        if (variants.length !== 1 || !object(e[variants[0]]) || (e.textRun && typeof e.textRun.content !== 'string')) fail();
      }
    }
    if (item.table) {
      if (!Array.isArray(item.table.tableRows) || !item.table.tableRows.length) fail();
      for (const row of item.table.tableRows) {
        if (!object(row) || !Array.isArray(row.tableCells) || !row.tableCells.length) fail();
        for (const cell of row.tableCells) {
          if (!object(cell) || !Array.isArray(cell.content) || !cell.content.length) fail();
          for (const child of cell.content) structure(child, depth + 1);
        }
      }
    }
    if (item.tableOfContents) {
      if (!Array.isArray(item.tableOfContents.content) || !item.tableOfContents.content.length) fail();
      for (const child of item.tableOfContents.content) structure(child, depth + 1);
    }
  }
  function visit(nodes, depth = 0) {
    if (depth > 16 || !Array.isArray(nodes)) fail();
    for (const tab of nodes) {
      if (!object(tab) || Object.keys(tab).some(k => !['tabProperties', 'documentTab', 'childTabs'].includes(k)) || !object(tab.tabProperties) || !object(tab.documentTab)) fail();
      const id = tab.tabProperties.tabId, data = tab.documentTab;
      if (typeof id !== 'string' || !id.length || id.length > 256 || seen.has(id) || seen.size >= 16 || !object(data.body) || !Array.isArray(data.body.content) || data.body.content.length < 2) fail();
      seen.add(id);
      let index = 0;
      for (const item of data.body.content) {
        if (!object(item) || (item.startIndex ?? 0) !== index || !Number.isSafeInteger(item.endIndex) || item.endIndex <= index || item.endIndex > 50001) fail();
        structure(item);
        index = item.endIndex;
      }
      bodyUnits += index;
      if (bodyUnits > 50000) fail();
      if (data.documentStyle !== undefined && !object(data.documentStyle)) fail();
      found.push({ tabId: id, title: typeof tab.tabProperties.title === 'string' ? tab.tabProperties.title.slice(0, 256) : '', documentStyle: data.documentStyle || {} });
      if (tab.childTabs !== undefined) visit(tab.childTabs, depth + 1);
    }
  }
  visit(doc.tabs);
  return { documentId: id, revisionId: doc.revisionId, title: typeof doc.title === 'string' ? doc.title.slice(0, 500) : '', tabs: found.map(({ documentStyle, ...t }) => t), tabStyles: found.map(({ tabId, documentStyle }) => ({ tabId, documentStyle })) };
}
function validatePageStyle(style, page) {
  if (!object(style) || Object.keys(style).some(k => !pageStyleKeys.has(k)) || !object(style.documentFormat) || Object.keys(style.documentFormat).some(k => k !== 'documentMode') || style.documentFormat.documentMode !== 'PAGES' || (page.size && style.flipPageOrientation === true)) throw formatError('unsupported');
  if (!backgroundRead.safeParse(style.background).success) throw formatError('unsupported');
  const dimension = z.object({ magnitude: z.number().finite().optional(), unit: z.literal('PT') }).strict();
  const size = z.object({ width: dimension, height: dimension }).strict();
  if (style.pageSize !== undefined && !size.safeParse(style.pageSize).success) throw formatError('unsupported');
  for (const key of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHeader', 'marginFooter']) if (style[key] !== undefined && !dimension.safeParse(style[key]).success) throw formatError('unsupported');
  for (const key of ['flipPageOrientation', 'useFirstPageHeaderFooter', 'useEvenPageHeaderFooter']) if (style[key] !== undefined && typeof style[key] !== 'boolean') throw formatError('unsupported');
  for (const key of ['defaultHeaderId', 'defaultFooterId', 'firstPageHeaderId', 'firstPageFooterId', 'evenPageHeaderId', 'evenPageFooterId']) if (style[key] !== undefined && typeof style[key] !== 'string') throw formatError('unsupported');
}
function pageCanonical(doc, page) {
  const copy = clone(doc); delete copy.revisionId;
  // Normalize only fields explicitly written. Everything else, including opaque
  // tables and unrelated styles, must compare exactly.
  const style = tabs(copy).find(t => t.tabProperties.tabId === page.tabId)?.documentTab.documentStyle;
  if (!style) throw formatError('unsupported');
  const fields = Object.keys(formatRequests({ ranges: [], page })[0].updateDocumentStyle.documentStyle);
  for (const field of fields) if (Object.hasOwn(style, field)) style[field] = normalized(style[field]);
  return copy;
}

export function formattingReadbackMatches(doc, op) {
  if (op.pageOnly === true) return isDeepStrictEqual(pageCanonical(doc, op.request.page), op.expected);
  const observed = canonical(doc, op.request.ranges);
  const expectedTabs = tabs(op.expected);
  for (const actualTab of tabs(observed)) {
    const expectedTab = expectedTabs.find(t => t.tabProperties.tabId === actualTab.tabProperties.tabId);
    if (!expectedTab) continue;
    for (const item of actualTab.documentTab.body.content) {
      if (!item.paragraph) continue;
      const r = op.request.ranges.find(r => r.tabId === actualTab.tabProperties.tabId && item.startIndex >= r.startIndex && item.endIndex <= r.endIndex);
      const requested = r?.paragraphStyle?.lineSpacing;
      // Old high-precision receipts retain their original strict comparison.
      if (!Number.isFinite(requested) || Math.abs(requested * 100 - Math.round(requested * 100)) >= 1e-8) continue;
      const prior = expectedTab.documentTab.body.content.find(p => p.startIndex === item.startIndex && p.endIndex === item.endIndex && p.paragraph);
      const desired = prior?.paragraph.paragraphStyle?.lineSpacing;
      const actual = item.paragraph.paragraphStyle?.lineSpacing;
      if (desired !== requested || !Number.isFinite(actual)) continue;
      const ulp = 2 ** (Math.floor(Math.log2(Math.abs(desired))) - 23);
      if (Math.abs(Math.fround(actual) - Math.fround(desired)) <= ulp) item.paragraph.paragraphStyle.lineSpacing = desired;
    }
  }
  return isDeepStrictEqual(observed, op.expected);
}
export function inspectFormatting(doc, id) {
  const text = inspectDocument(doc, id);
  if (doc.documentStyle && Object.keys(doc.documentStyle).length) throw formatError('unsupported');
  for (const tab of tabs(doc)) {
    if (tab.documentTab.documentStyle?.documentFormat?.documentMode === 'PAGELESS') throw formatError('unsupported');
    for (const item of tab.documentTab.body.content) {
      if (item.sectionBreak && Object.entries(item.sectionBreak.sectionStyle || {}).some(([k, v]) => !['sectionType', 'contentDirection', 'columnSeparatorStyle'].includes(k) && !(k === 'columnProperties' && Array.isArray(v) && !v.length))) throw formatError('unsupported');
      if (item.paragraph?.bullet) throw formatError('unsupported');
    }
  }
  return { ...text, paragraphs: tabs(doc).flatMap(tab => tab.documentTab.body.content.filter(i => i.paragraph).map(i => ({
    tabId: tab.tabProperties.tabId, startIndex: i.startIndex, endIndex: i.endIndex,
    text: i.paragraph.elements.map(e => e.textRun.content).join(''), paragraphStyle: i.paragraph.paragraphStyle || {},
    runs: i.paragraph.elements.map(e => ({ startIndex: e.startIndex, endIndex: e.endIndex, textStyle: e.textRun.textStyle || {} })),
  }))), tabStyles: tabs(doc).map(t => ({ tabId: t.tabProperties.tabId, documentStyle: t.documentTab.documentStyle || {}, namedStyles: t.documentTab.namedStyles || {} })),
    inheritance: 'Styles shown are explicit API properties only. Missing values inherit named/default styles; no font rendering or availability is established. Named styles are not changed.',
  };
}
function plan(doc, args, legacy = false) {
  const pageOnly = args.ranges.length === 0 && !legacy;
  const inspected = pageOnly ? inspectPageDocument(doc, documentId(args.document)) : inspectFormatting(doc, documentId(args.document));
  if (inspected.revisionId !== args.expectedRevisionId) throw formatError('stale');
  if (args.page) {
    const style = tabs(doc).find(t => t.tabProperties.tabId === args.page.tabId)?.documentTab.documentStyle;
    if (pageOnly) validatePageStyle(style, args.page);
    else if (style?.documentFormat?.documentMode !== 'PAGES' || (args.page.size && style.flipPageOrientation === true) || (args.page.backgroundColor && !backgroundRead.safeParse(style.background).success)) throw formatError('unsupported');
  }
  let units = 0;
  const selections = [];
  for (const range of args.ranges) {
    if (range.endIndex <= range.startIndex || selections.some(s => s.tabId === range.tabId && range.startIndex < s.endIndex && range.endIndex > s.startIndex)) throw formatError('invalid');
    const paragraphs = inspected.paragraphs.filter(p => p.tabId === range.tabId && p.startIndex >= range.startIndex && p.endIndex <= range.endIndex);
    if (!paragraphs.length || paragraphs[0].startIndex !== range.startIndex || paragraphs.at(-1).endIndex !== range.endIndex) throw formatError('invalid');
    units += range.endIndex - range.startIndex;
    if (units > 8000) throw formatError('invalid');
    selections.push({ ...range, paragraphs });
  }
  const expected = clone(doc);
  for (const tab of pageOnly ? [] : tabs(expected)) {
    for (const item of tab.documentTab.body.content) {
      if (!item.paragraph) continue;
      const r = args.ranges.find(r => r.tabId === tab.tabProperties.tabId && item.startIndex >= r.startIndex && item.endIndex <= r.endIndex);
      if (!r) continue;
      const patch = stylePatch(r);
      if (r.paragraphStyle) item.paragraph.paragraphStyle = { ...item.paragraph.paragraphStyle, ...patch.paragraphStyle };
      if (r.textStyle) for (const e of item.paragraph.elements) {
        const old = e.textRun.textStyle || {};
        e.textRun.textStyle = { ...old, ...patch.textStyle };
        if (patch.textStyle.weightedFontFamily) e.textRun.textStyle.weightedFontFamily = { ...inheritedText(tab, item.paragraph).weightedFontFamily, ...old.weightedFontFamily, ...patch.textStyle.weightedFontFamily };
      }
    }
  }
  if (args.page) Object.assign(tabs(expected).find(t => t.tabProperties.tabId === args.page.tabId).documentTab.documentStyle, formatRequests(args).at(-1).updateDocumentStyle.documentStyle);
  const proposal = { documentId: inspected.documentId, title: inspected.title, expectedRevisionId: inspected.revisionId,
    selections, page: args.page ? { before: inspected.tabStyles.find(t => t.tabId === args.page.tabId).documentStyle, after: args.page } : null,
    limits: 'Only listed explicit properties change. Text, paragraph boundaries and named styles stay unchanged. Inherited values become explicit overrides for the selected properties. Font-family readback does not establish rendering or font-menu availability.' };
  if (Buffer.byteLength(JSON.stringify(proposal), 'utf8') > 48_000) throw formatError('invalid');
  return { proposal, ...(pageOnly ? { pageOnly: true } : {}), before: hash(pageOnly ? pageCanonical(doc, args.page) : canonical(doc)), expected: pageOnly ? pageCanonical(expected, args.page) : canonical(expected, args.ranges) };
}
export function createDocsFormatService({ store, drive, docs, approve = async (_p, _s) => /** @type {unknown} */ ({ outcome: 'cancelled', reason: 'request-aborted' }), diagnose = (_stage, _error) => {}, clock = () => Date.now(), approvalRequired = async () => true }) {
  const active = new Set();
  async function needsApproval() {
    try { return (await approvalRequired()) !== false; }
    catch { throw docsError('approval_policy_unavailable'); }
  }
  async function record(account) { const r = await store.byEmail(account); if (!r) throw docsError('unknown_account'); return r; }
  async function load(r, id, pageOnly = false) {
    const file = await drive.getFile(r, id);
    if (file.id !== id || file.trashed !== false || file.mimeType !== 'application/vnd.google-apps.document') throw docsError('wrong_type');
    const doc = await docs.inspect(r, id); if (pageOnly) inspectPageDocument(doc, id); else inspectFormatting(doc, id); return doc;
  }
  const receipt = (op, extra = {}) => ({ operationId: op.operationId, documentId: op.documentId, outcome: op.state, retrySafe: false, approval: op.approval || 'not_checked',
    providerAcknowledged: typeof op.appliedRevision === 'string' && !!op.appliedRevision,
    appliedRevisionId: op.appliedRevision || null,
    // Separate this call's zero-write status/replay response from execution
    // evidence known to this result. After restart only persisted evidence is
    // available. Null preserves legacy/unsaved intent ambiguity; never backfill it.
    historicalWriteAttempted: typeof op.writeAttempted === 'boolean' ? op.writeAttempted : null,
    guidance: 'Only verified confirms exact API style/text readback, not font rendering. After uncertainty use gdocs_formatting_status with the SAME account/key; never replay, roll back or replace a key to bypass recovery.', ...extra });
  async function save(op, state) { op.state = state; await store.updateFormatting(op); }
  async function inspect(input) {
    const args = formatInspectSchema.parse(input), r = await record(args.account);
    const id = documentId(args.document), pageOnly = args.mode === 'page';
    const doc = await load(r, id, pageOnly);
    const result = pageOnly ? inspectPageDocument(doc, id) : inspectFormatting(doc, id);
    const { tabs: tabText, ...rest } = result;
    return { account: r.email, ...rest, tabs: tabText.map(({ runs, text, ...t }) => t), complete: true };
  }
  async function format(input, signal, requestApproval = approve) {
    const parsed = formatSchema.safeParse(input); if (!parsed.success) throw formatError('invalid');
    const args = parsed.data, r = await record(args.account), id = documentId(args.document);
    const { account, preview, ...request } = args; request.document = id;
    const requestHash = hash(request);
    let op = await store.getFormatting(args.operationId);
    if (op && (op.subject !== r.subject || op.requestHash !== requestHash)) throw formatError('conflict');
    if (!op) {
      const prepared = plan(await load(r, id, args.ranges.length === 0), args);
      op = { operationId: args.operationId, subject: r.subject, documentId: id, requestHash, request,
        ...prepared, createdAt: clock(), state: 'proposed' };
      if (!await store.reserveFormatting(op)) return format(input, signal, requestApproval); // local reservation race only
    }
    if (args.preview || op.state !== 'proposed') return receipt(op, { writeAttempted: false, historical: true, proposal: op.proposal });
    if (clock() - op.createdAt >= 600_000) { await save(op, 'expired'); return receipt(op, { writeAttempted: false }); }
    if (!await store.claimFormatting(op.operationId, id)) throw Object.assign(formatError('busy'), { operationId: await store.activeFormatting(id) });
    active.add(op.operationId); op.state = 'reviewing'; let stage = 'preflight';
    try {
      signal?.throwIfAborted();
      const writer = await docs.prepareWrite(r);
      stage = 'approval';
      let ownerApproved = false;
      if (await needsApproval()) {
        const decision = docsApprovalDecision(await requestApproval({ ...op.proposal, account: r.email, operationId: op.operationId }, signal));
        if (decision.outcome !== 'approved') {
          diagnoseDocsApproval(diagnose, decision);
          await save(op, decision.outcome); return receipt(op, { writeAttempted: false, reason: decision.reason });
        }
        ownerApproved = true;
      }
      stage = 'revalidate';
      const fresh = plan(await load(r, id, op.pageOnly === true), args, op.pageOnly !== true);
      if (fresh.before !== op.before) throw formatError('stale');
      if (clock() - op.createdAt >= 600_000) { await save(op, 'expired'); return receipt(op, { writeAttempted: false }); }
      signal?.throwIfAborted();
      if (!ownerApproved && await needsApproval()) {
        await save(op, 'approval_required');
        return receipt(op, { writeAttempted: false, guidance: 'Docs approval was re-enabled before submission. No write was attempted. Prepare a fresh reviewed proposal.' });
      }
      op.approval = ownerApproved ? 'owner_approved' : 'disabled_in_settings';
      stage = 'reserve';
      if (!await store.startFormattingWrite(op)) throw formatError('stale');
      op.state = 'writing'; stage = 'write';
      const result = await writer.format(args, signal, async () => {
        // Local observations AFTER final async provider auth, not an atomic epoch
        // or remote grant lock. Account/claim may change during later awaits.
        const currentAccount = await record(args.account);
        if (currentAccount.subject !== op.subject) throw docsError('authorization_failed');
        const claimed = await store.getFormatting(op.operationId);
        if (claimed?.state !== 'writing' || claimed.subject !== op.subject || claimed.requestHash !== op.requestHash) throw formatError('stale');
        if (!ownerApproved && await needsApproval()) throw formatError('approval_required');
        // Check these after ALL callback awaits, including policy/claim reads.
        signal?.throwIfAborted();
        if (clock() - op.createdAt >= 600_000) throw formatError('stale');
      });
      stage = 'verify';
      op.writeAttempted = true;
      // Persist provider revision before readback. Lost/malformed responses remain
      // recoverable by exact comparison but never prove which actor wrote styles.
      const revision = result?.writeControl?.requiredRevisionId;
      op.appliedRevision = result?.documentId === id && Array.isArray(result.replies) && result.replies.length === formatRequests(args).length
        && typeof revision === 'string' && revision.length > 0 && revision.length <= 2048 ? revision : null;
      await save(op, 'uncertain');
      const after = await load(r, id, op.pageOnly === true);
      const matches = op.appliedRevision !== null && after.revisionId === op.appliedRevision && formattingReadbackMatches(after, op);
      if (!matches) diagnose('docs_format_verification_mismatch', null);
      await save(op, matches ? 'verified' : 'uncertain');
      return receipt(op, { writeAttempted: true, revisionId: matches ? after.revisionId : null });
    } catch (error) {
      diagnose(`docs_format_${stage}`, error);
      const attempted = stage === 'verify' || (stage === 'write' && error?.docsWriteAttempted !== false);
      // A GET/storage failure cannot reject the earlier POST or release its claim.
      const rejected = stage === 'write' && attempted && ['write_rejected', 'authorization_failed', 'scope_required', 'stale_revision'].includes(error?.docsCode);
      op.writeAttempted = attempted;
      try { await save(op, !attempted ? 'not_submitted' : rejected ? 'rejected' : 'uncertain'); }
      catch (storageError) { diagnose('docs_format_receipt', storageError); }
      // Keep the legacy rejected-call convention, but expose the saved attempt
      // separately. Never reuse a no-write inspection message after submission.
      return receipt(op, { writeAttempted: attempted && !rejected, error: attempted && !rejected
        ? 'Formatting was submitted but could not be verified. Recover using the SAME account and operationId; never replay or replace an uncertain write.' : formatMessage(error) });
    } finally { active.delete(op.operationId); }
  }
  async function status(input) {
    const parsed = formatStatusSchema.safeParse(input); if (!parsed.success) throw formatError('invalid');
    const args = parsed.data, r = await record(args.account), op = await store.getFormatting(args.operationId);
    if (!op || op.subject !== r.subject) throw formatError('unknown_operation');
    if (active.has(op.operationId)) return receipt(op, { inProgress: true, writeAttempted: false });
    // Never clear a reviewing lock on read: another process may still own it.
    if (!['writing', 'uncertain', 'verified'].includes(op.state)) return receipt(op, { historical: true, writeAttempted: false });
    try {
      const after = await load(r, op.documentId, op.pageOnly === true), matches = formattingReadbackMatches(after, op);
      const evidence = { observedRevisionId: after.revisionId, responseRevisionMatchesReadback: !!op.appliedRevision && after.revisionId === op.appliedRevision };
      if (op.state === 'verified' && !matches) return receipt(op, { ...evidence, outcome: 'changed_since_verification', readbackMatches: false, writeAttempted: false });
      // Exact present state proves readback, not causality/HTTP completion. Never
      // release an unresolved lock: a lost request may still be in flight.
      if (op.state === 'verified') return receipt(op, { ...evidence, readbackMatches: matches, writeAttempted: false });
      if (matches && op.appliedRevision && after.revisionId === op.appliedRevision) {
        await save(op, 'verified'); return receipt(op, { ...evidence, readbackMatches: true, writeAttempted: false, revisionId: after.revisionId });
      }
      if (!matches) diagnose('docs_format_recovery_mismatch', null);
      return receipt(op, { ...evidence, outcome: matches ? 'observed_matching' : 'uncertain', readbackMatches: matches, writeAttempted: false,
        guidance: 'Read-only observation, not proof the lost request finished or this operation caused the styles. Original unresolved lock is retained. Never replay; reconcile with the owner before further formatting.' });
    } catch (error) { diagnose('docs_format_recovery', error); return receipt(op, { outcome: 'verification_unavailable', writeAttempted: false }); }
  }
  return { inspect, format, status };
}
