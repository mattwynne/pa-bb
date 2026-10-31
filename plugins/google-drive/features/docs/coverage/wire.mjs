// Test-only discovery walker plus a deliberately bounded set of reviewed payload rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const bytes = readFileSync(new URL('./fixtures/docs-discovery.json', import.meta.url));
export const discoveryDigest = createHash('sha256').update(bytes).digest('hex');
assert.equal(discoveryDigest, '3948e9385816c87782b0548c577a39d240336015d2f4e63e1f40bac835f81741');
const { schemas } = JSON.parse(bytes);
const denied = s => s.readOnly || /output only|read.only/i.test(s.description ?? '');
function resolve(s) { return s.$ref ? { ...schemas[s.$ref], ...s, $ref: undefined } : s; }
const aliases = { named_style_type: 'namedStyleType', text_style: 'textStyle', paragraph_style: 'paragraphStyle' };
const canonical = p => p.split('.').map(x => aliases[x] ?? x).join('.');
export const roots = { updateTextStyle: 'textStyle', updateParagraphStyle: 'paragraphStyle', updateDocumentStyle: 'documentStyle', updateSectionStyle: 'sectionStyle', updateNamedStyle: 'namedStyle', updateTableColumnProperties: 'tableColumnProperties', updateTableCellStyle: 'tableCellStyle', updateTableRowStyle: 'tableRowStyle', updateDropdownDefinitionProperties: 'dropdownDefinitionProperties', updateDropdownProperties: 'dropdownProperties', insertDate: 'dateElementProperties' };
function requestSchema(name) {
  const s = schemas.Request.properties[name]; assert.ok(s, `unknown request: ${name}`); return resolve(s);
}
export function writablePath(name, path, root = roots[name]) {
  let s = root ? requestSchema(name).properties[root] : requestSchema(name);
  assert.ok(s, `missing request root: ${name}`);
  for (const part of canonical(path).split('.')) {
    s = resolve(s); if (s.type === 'array') s = resolve(s.items);
    s = s.properties?.[part]; assert.ok(s, `unknown schema path: ${name}/${path}`);
    assert.ok(!denied(s), `output-only path: ${name}/${path}`);
  }
  return resolve(s);
}
function valueCheck(schema, value, path) {
  assert.ok(!denied(schema), `output-only field: ${path}`);
  const ref = schema.$ref, s = resolve(schema);
  if (s.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `object type: ${path}`);
    for (const [k, v] of Object.entries(value)) {
      const child = s.properties?.[k] ?? s.additionalProperties;
      assert.ok(child, `unknown schema field: ${path}.${k}`); valueCheck(child, v, `${path}.${k}`);
    }
  } else if (s.type === 'array') {
    assert.ok(Array.isArray(value), `array type: ${path}`); value.forEach((v, i) => valueCheck(s.items, v, `${path}[${i}]`));
  } else if (s.type === 'integer' || s.type === 'number') {
    assert.ok(typeof value === 'number' && Number.isFinite(value) && (s.type !== 'integer' || Number.isInteger(value)), `number type: ${path}`);
    if (s.format === 'int32') assert.ok(value >= -2147483648 && value <= 2147483647, `int32: ${path}`);
  } else assert.equal(typeof value, s.type, `value type: ${path}`);
  if (s.enum) {
    const i = s.enum.indexOf(value); assert.ok(i >= 0, `enum: ${path}`);
    assert.ok(!/output only|read.only/i.test(s.enumDescriptions?.[i] ?? '') && !/UNSPECIFIED/.test(value), `output-only/unspecified enum: ${path}`);
  }
  if (ref === 'Dimension') {
    assert.deepEqual(Object.keys(value).sort(), ['magnitude', 'unit'], `complete dimension: ${path}`);
    assert.equal(value.unit, 'PT', `dimension unit: ${path}`);
    assert.ok(value.magnitude >= 0, `dimension magnitude: ${path}`);
  }
  if (ref === 'ParagraphBorder') assert.deepEqual(Object.keys(value).sort(), ['color','dashStyle','padding','width'], `complete paragraph border: ${path}`);
  if (ref === 'WeightedFontFamily') {
    assert.ok(typeof value.fontFamily === 'string' && value.fontFamily.trim().length, `nonempty weighted font family: ${path}`);
    if (Object.hasOwn(value, 'weight')) assert.ok(value.weight >= 100 && value.weight <= 900 && value.weight % 100 === 0, `font weight domain: ${path}`);
  }
  if (ref === 'TextStyle' && value.fontSize) assert.ok(value.fontSize.magnitude > 0, 'positive font size');
  if (ref === 'Location') assert.ok(typeof value.tabId === 'string' && value.tabId.length && Number.isInteger(value.index) && value.index >= 0, `explicit index/tab location: ${path}`);
  if (ref === 'EndOfSegmentLocation') assert.ok(typeof value.tabId === 'string' && value.tabId.length, 'explicit end-of-segment tab');
  if (ref === 'RgbColor') for (const v of Object.values(value)) assert.ok(v >= 0 && v <= 1, `colour: ${path}`);
  if (s.format === 'google-datetime') assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)), 'timestamp');
}
function leaves(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}
const get = (v, path) => path.split('.').reduce((o, k) => o?.[k], v);
const supported = new Set(['updateTextStyle','updateParagraphStyle','updateDocumentStyle','updateSectionStyle','updateNamedStyle','updateTableColumnProperties','insertDate','replaceAllText']);
export function validateRequest(request, effects = {}) {
  assert.ok(effects && typeof effects === 'object' && !Array.isArray(effects), 'effects object');
  for (const [key,paths] of Object.entries(effects)) {
    assert.ok(['set','reset','clearAll'].includes(key), 'unknown effects field');
    assert.ok(Array.isArray(paths) && paths.every(p => typeof p === 'string' && p.length), 'effect paths array');
    assert.equal(new Set(paths).size,paths.length,'duplicate effect path');
  }
  assert.equal(Object.keys(request).length, 1, 'one request union member');
  const [name, payload] = Object.entries(request)[0];
  assert.ok(supported.has(name), `unsupported payload validator: ${name}`);
  valueCheck(requestSchema(name), payload, name);
  if (['replaceAllText','insertDate'].includes(name)) assert.equal(Object.keys(effects).length, 0, 'style effects on non-style request');
  if (name === 'replaceAllText') {
    assert.ok(payload.containsText?.text && payload.containsText.matchCase === true && payload.containsText.searchByRegex === false, 'literal replacement contract');
    assert.ok(payload.tabsCriteria?.tabIds?.length && typeof payload.replaceText === 'string', 'explicit replacement tabs'); return;
  }
  if (name === 'insertDate') {
    assert.ok(!!payload.location !== !!payload.endOfSegmentLocation, 'one date location');
    const p = payload.dateElementProperties;
    assert.ok(p?.timestamp && p.timeZoneId && p.locale && p.dateFormat && p.timeFormat, 'explicit date properties');
    const locale = schemas.DateElementProperties.properties.locale.description;
    assert.ok(locale.includes(`\`${p.locale}\``), 'locale');
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: p.timeZoneId }), 'timezone'); return;
  }
  const root = roots[name], style = payload[root];
  assert.ok(style && typeof payload.fields === 'string' && payload.fields, 'style/mask required');
  const raw = payload.fields.split(','), masks = raw.map(canonical);
  assert.equal(new Set(masks).size, masks.length, 'duplicate mask');
  for (const mask of masks) { assert.ok(!mask.includes('*'), 'wildcard mask'); writablePath(name, mask); }
  const resets = effects.reset ?? [], clearAll = effects.clearAll ?? [];
  for (const path of clearAll) {
    assert.ok(name === 'updateNamedStyle' && ['textStyle','paragraphStyle'].includes(path), 'unknown/unsupported clearAll effect');
    assert.ok(masks.includes(path) && get(style,path) && Object.keys(get(style,path)).length === 0, 'clearAll must match masked empty parent');
    assert.ok(!masks.some(m => m.startsWith(`${path}.`)), 'clearAll overlaps child mask');
  }
  for (const path of [...resets,...clearAll]) assert.ok(!(effects.set ?? []).includes(path), 'set/reset/clearAll overlap');
  for (const mask of masks) assert.ok(!/(^|\.)border(?:Top|Bottom|Left|Right|Between)\./.test(mask), 'whole paragraph border mask');
  for (const path of resets) {
    assert.ok(!/\.(magnitude|unit)$/.test(path), 'partial dimension reset unsupported');
    const resetAllowed = name === 'updateTextStyle' ? ['bold','italic','underline','strikethrough','smallCaps','fontSize','weightedFontFamily','foregroundColor','backgroundColor','baselineOffset','link']
      : name === 'updateParagraphStyle' ? ['alignment','spaceAbove','spaceBelow','lineSpacing','indentStart','indentEnd','indentFirstLine','borderTop','borderBottom','borderLeft','borderRight','borderBetween']
      : name === 'updateNamedStyle' ? ['textStyle.bold','paragraphStyle.alignment'] : [];
    assert.ok(resetAllowed.includes(path), `unsupported reset validator: ${name}/${path}`);
    assert.ok(masks.includes(path) && get(style, path) === undefined, `invalid reset: ${path}`);
  }
  for (const mask of masks) if (get(style, mask) === undefined) assert.ok(resets.includes(mask), `undeclared reset: ${mask}`);
  for (const leaf of leaves(style).filter(Boolean)) assert.ok(masks.some(p => leaf === p || leaf.startsWith(`${p}.`)), `unmasked supplied value: ${leaf}`);
  if (effects.set) assert.deepEqual([...effects.set].sort(), masks.filter(p => !resets.includes(p) && !clearAll.includes(p)).sort(), 'declared set/mask effects');
  if (name === 'updateNamedStyle') {
    assert.ok(payload.tabId, 'explicit named-style tab');
    assert.ok(raw.includes('named_style_type') && style.namedStyleType, 'named style required type mask');
    for (const parent of ['textStyle','paragraphStyle']) {
      const alias = parent === 'textStyle' ? 'text_style' : 'paragraph_style';
      const children = masks.filter(p => p.startsWith(`${parent}.`));
      if (children.length || parent in style) assert.ok(raw.includes(alias), 'named style required parent mask');
      if (style[parent] && Object.keys(style[parent]).length === 0) assert.ok(clearAll.includes(parent), 'explicit clear-all required');
      for (const leaf of style[parent] ? leaves(style[parent], parent) : []) if (leaf !== parent)
        assert.ok(masks.some(mask => mask.startsWith(`${parent}.`) && (leaf === mask || leaf.startsWith(`${mask}.`))), 'named style nested child mask');
    }
  } else assert.equal(clearAll.length, 0, 'unsupported clear-all');
  if (['updateTextStyle','updateParagraphStyle','updateSectionStyle'].includes(name)) assert.ok(payload.range, 'required range');
  if (name === 'updateSectionStyle' && style.columnProperties) assert.ok(style.columnProperties.length >= 1 && style.columnProperties.length <= 3, 'section columns one to three');
  if (payload.range) assert.ok(payload.range.tabId && Number.isInteger(payload.range.startIndex) && payload.range.startIndex >= 0 && payload.range.endIndex > payload.range.startIndex, 'explicit bounded range');
  if (name === 'updateDocumentStyle') {
    assert.ok(payload.tabId, 'explicit document tab');
    if (style.pageSize) {
      assert.ok(masks.includes('pageSize'), 'whole pageSize mask');
      assert.deepEqual(Object.keys(style.pageSize).sort(), ['height','width'], 'pageSize dimensions');
      for (const dim of Object.values(style.pageSize)) assert.ok(dim.magnitude > 0, 'positive page dimension');
    }
  }
  if (name === 'updateTableColumnProperties') {
    assert.ok(payload.tableStartLocation?.tabId && Number.isInteger(payload.tableStartLocation.index), 'table location');
    if (style.width) assert.ok(style.width.magnitude >= 5, 'minimum column width');
    if (style.widthType === 'FIXED_WIDTH') assert.ok(style.width, 'fixed width required');
    if (payload.columnIndices) assert.ok(payload.columnIndices.every(n => n >= 0) && new Set(payload.columnIndices).size === payload.columnIndices.length, 'column indices');
  }
  if (name === 'updateParagraphStyle') for (const mask of masks) if (/^border/.test(mask)) {
    assert.ok(!mask.includes('.'), 'whole paragraph border mask');
    if (style[mask]) assert.deepEqual(Object.keys(style[mask]).sort(), ['color','dashStyle','padding','width'], 'complete paragraph border');
  }
}
export function validatePlannedMappings(m) {
  let requests = 0, paths = 0;
  for (const [operation, b] of Object.entries(m.bindingCatalog.operationBindings)) {
    for (const name of b.requests ?? []) if (!name.includes('.')) { requestSchema(name); requests++; }
    for (const names of Object.values(b.requestsByVariant ?? {})) for (const name of names) assert.ok(b.requests.includes(name), 'variant request outside binding');
    for (const [path, values] of Object.entries(b.enums ?? {})) {
      assert.equal(b.requests.length, 1, 'enum mapping needs exact request');
      const schema = writablePath(b.requests[0], path);
      for (const value of values) valueCheck(schema, value, path);
    }
    const request = m.wireSchemaContract.fieldBindingRequests[operation];
    if (!request) continue;
    const fields = [...(Array.isArray(b.fields) ? b.fields : []), ...Object.values(b.fieldsByVariant ?? {})];
    for (const field of fields.flatMap(f => f.split(','))) { writablePath(request, field); paths++; }
  }
  for (const [request, fields] of Object.entries(m.wireSchemaContract.extraWritablePaths)) for (const f of fields) { writablePath(request, f); paths++; }
  return { requests, paths, payloadValidation: 'only explicitly supported actual fixtures; planned mappings are structural evidence' };
}
