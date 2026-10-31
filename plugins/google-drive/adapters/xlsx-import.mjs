// A deliberately conservative XLSX import gate, not an Excel evaluator. Never
// extracts to disk, runs code, fetches relationships, or rewrites workbook bytes.
import { readXlsxZip } from './xlsx-zip.mjs';
import { SaxesParser } from 'saxes';
import { uploadError } from '../core/upload.mjs';
import { ooxmlMediaType, inspectOoxmlMedia } from './ooxml-media.mjs';
const functions = new Set(('ABS ACOS AND ASIN ATAN AVERAGE AVERAGEIF AVERAGEIFS CEILING CHAR CHOOSE CLEAN CODE COLUMN COLUMNS CONCAT CONCATENATE COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS DATE DATEDIF DATEVALUE DAY DAYS EDATE EOMONTH EXACT EXP FALSE FIND FLOOR FV HLOOKUP HOUR IF IFERROR IFNA IFS INDEX INT IPMT IRR ISBLANK ISERROR ISNA ISNUMBER ISTEXT LARGE LEFT LEN LN LOG LOG10 LOOKUP LOWER MATCH MAX MEDIAN MID MIN MINUTE MOD MONTH MROUND N NA NETWORKDAYS NOT NOW NPER NPV OR PI PMT POWER PPMT PRODUCT PROPER PV RATE REPLACE REPT RIGHT ROUND ROUNDDOWN ROUNDUP ROW ROWS SEARCH SECOND SIGN SMALL SQRT SUBSTITUTE SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT TEXT TIME TODAY TRIM TRUE TRUNC UPPER VALUE VLOOKUP WEEKDAY WEEKNUM WORKDAY XIRR XNPV YEAR YEARFRAC').split(' '));
function xml(bytes, onOpen, onText = () => {}, onClose = () => {}) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw uploadError('conversion'); });
  parser.on('error', () => { throw uploadError('conversion'); });
  parser.on('opentag', node => onOpen(node.local, Object.fromEntries(Object.values(node.attributes).map(a => [a.name, a.value]))));
  parser.on('text', onText); parser.on('cdata', onText); parser.on('closetag', node => onClose(node.local));
  parser.write(text).close();
}
export function inspectXlsx(bytes, name) {
  try {
    if (!/\.xlsx$/i.test(name)) throw uploadError('conversion');
    const files = readXlsxZip(bytes);
    if (!files['xl/workbook.xml'] || !files['[Content_Types].xml']) throw uploadError('conversion');
    const tabs = [], media = new Map(), defaults = new Map(), overrides = new Map(); let formulaCount = 0, cells = 0;
    // Never skip an opaque part just because its extension isn't XML. A package
    // can live anywhere in the archive, not only under xl/embeddings/.
    for (const [path, content] of Object.entries(files)) if (!/\.(?:xml|rels)$/i.test(path)) {
      if (path.endsWith('/') && content.length === 0) continue;
      const type = ooxmlMediaType(path, 'xl');
      if (!type) throw uploadError('conversion');
      inspectOoxmlMedia(content, type); media.set(path, type);
    }
    for (const [path, content] of Object.entries(files)) {
      if (!/\.(?:xml|rels)$/i.test(path)) continue;
      let formula = null, formulaTag = null;
      xml(content, (tag, a) => {
        if (/^(?:oleObjects?|embeddedObject|embeddedPackage|controls?)$/i.test(tag)) throw uploadError('conversion');
        if (tag === 'Relationship') {
          if (a.TargetMode?.toLowerCase() === 'external' || /^(?:[a-z]+:|\/\/)/i.test(a.Target || '')
            || /vba|macro|externalLink|connection|oleObject|activeX|attachedTemplate|queryTable/i.test(a.Type || '')
            || /\/package(?:[?#].*)?$/i.test((a.Type || '').trim())) throw uploadError('conversion');
          if (/\/officeDocument$/i.test(a.Type || '') && (path !== '_rels/.rels' || !/^\/?xl\/workbook\.xml$/.test(a.Target || ''))) throw uploadError('conversion');
          if (/\/worksheet$/i.test(a.Type || '') && (path !== 'xl/_rels/workbook.xml.rels' || !/^worksheets\/sheet[0-9]+\.xml$/.test(a.Target || ''))) throw uploadError('conversion');
        }
        if (['Override', 'Default'].includes(tag)) {
          if (path === '[Content_Types].xml') {
            const override = tag === 'Override', key = override ? a.PartName?.startsWith('/') && a.PartName.slice(1) : a.Extension;
            const declarations = override ? overrides : defaults;
            if (!key || declarations.has(key) || typeof a.ContentType !== 'string') throw uploadError('conversion');
            declarations.set(key, a.ContentType);
            if (!/(?:\+xml|\/xml)$/i.test(a.ContentType)) {
              const expected = ooxmlMediaType(override ? key : `xl/media/declaration.${key}`, 'xl');
              if (!expected || expected !== a.ContentType || (override && media.get(key) !== expected)) throw uploadError('conversion');
            }
          }
          if (/macroEnabled|vbaProject|externalLink|connection|oleObject|activeX/i.test(a.ContentType || '')) throw uploadError('conversion');
          if (/(?:\+xml|\/xml)$/i.test(a.ContentType || '') && (tag === 'Override' ? !/\.(?:xml|rels)$/i.test(a.PartName || '') : !/^(?:xml|rels)$/i.test(a.Extension || ''))) throw uploadError('conversion');
          if (/spreadsheetml\.(?:sheet|template)\.main\+xml$/i.test(a.ContentType || '') && (tag !== 'Override' || a.PartName !== '/xl/workbook.xml')) throw uploadError('conversion');
          if (/worksheet\+xml$/i.test(a.ContentType || '') && (tag !== 'Override' || !/^\/xl\/worksheets\/sheet[0-9]+\.xml$/.test(a.PartName || ''))) throw uploadError('conversion');
        }
        if (path === 'xl/workbook.xml' && tag === 'sheet') {
          if (tabs.length >= 100 || typeof a.name !== 'string' || !a.name || a.name.length > 100 || tabs.includes(a.name)) throw uploadError('conversion');
          tabs.push(a.name);
        }
        // Named expressions and data tables can hide external/evaluated content.
        if (tag === 'definedName' && !['_xlnm.Print_Area', '_xlnm.Print_Titles'].includes(a.name)) throw uploadError('conversion');
        // Inspect formula/cell elements in EVERY XML part as defense in depth:
        // relationship-selected noncanonical worksheets cannot bypass the gate.
        if (tag === 'c' && ++cells > 100_000) throw uploadError('conversion');
        if (['f', 'formula', 'formula1', 'formula2', 'calculatedColumnFormula', 'totalsRowFormula', 'definedName'].includes(tag)) {
          if (formula !== null || (a.t && a.t !== 'normal')) throw uploadError('conversion');
          formula = ''; formulaTag = tag; if (tag === 'f') formulaCount++;
        }
      }, text => { if (formula !== null) { formula += text; if (formula.length > 8192) throw uploadError('conversion'); } }, tag => {
        if (tag !== formulaTag || formula === null) return;
        // Quoted strings and sheet names are inert. Everything else is restricted
        // to ordinary references/operators and the fixed, network-free list.
        const expression = formula.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, '');
        if (!formula || /[\[\]{}|\\]|https?:|file:|ftp:|@/i.test(expression)) throw uploadError('conversion');
        for (const match of expression.matchAll(/([\p{L}_][\p{L}\p{N}_.]*)\s*\(/gu)) if (!functions.has(match[1].toUpperCase())) throw uploadError('conversion');
        formula = null; formulaTag = null;
      });
    }
    for (const [path, type] of media) if ((overrides.get(path) || defaults.get(path.split('.').at(-1))) !== type) throw uploadError('conversion');
    if (!tabs.length) throw uploadError('conversion');
    return { tabs, sourceFormulaCount: formulaCount, sourceCellCount: cells,
      fidelity: 'Not guaranteed. Ordinary XLSX only; no macros, external relationships/connections, named expressions, shared/array formulas or functions outside the documented conservative list.' };
  } catch { throw uploadError('conversion'); }
}
