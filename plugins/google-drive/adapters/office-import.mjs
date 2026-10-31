// Conservative, non-evaluating OOXML inspection. No extraction, link fetching,
// reconstruction or modification of source bytes. Unknown parts fail closed.
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { readOoxmlZip } from './xlsx-zip.mjs';
import { uploadError } from '../core/upload.mjs';
import { ooxmlMediaType, inspectOoxmlMedia } from './ooxml-media.mjs';
const O = 'http://schemas.openxmlformats.org/';
const R = `${O}officeDocument/2006/relationships`;
const W = `${O}wordprocessingml/2006/main`, P = `${O}presentationml/2006/main`, A = `${O}drawingml/2006/main`;
const PKG = `${O}package/2006/relationships`, CT = `${O}package/2006/content-types`;
const namespaces = new Set([W, P, A, R, PKG, CT, `${O}drawingml/2006/wordprocessingDrawing`, `${O}drawingml/2006/picture`, `${O}officeDocument/2006/math`,
  `${O}markup-compatibility/2006`, `${O}package/2006/metadata/core-properties`, `${O}officeDocument/2006/extended-properties`, `${O}officeDocument/2006/docPropsVTypes`,
  'http://purl.org/dc/elements/1.1/', 'http://purl.org/dc/terms/', 'http://www.w3.org/2001/XMLSchema-instance']);
const inactiveIds = 'http://schemas.microsoft.com/office/word/2010/wordml';
const forbidden = /^(?:altChunk|object|oleObj|control|controls|contentPart|subDoc|attachedTemplate|mailMerge|dataBinding|instrText|fldSimple|fldChar|docVars|externalData|audio|audioCd|video|audioFile|videoFile|wavAudioFile|snd|sndAc|hlinkClick|hlinkHover|extLst|custDataLst|webPr|timing|cmd|frameset|frame|sourceFileName|saveThroughXslt|movie)$/i;
const wordTypes = { document: 'document.main', styles: 'styles', numbering: 'numbering', settings: 'settings', fontTable: 'fontTable', webSettings: 'webSettings', footnotes: 'footnotes', endnotes: 'endnotes', comments: 'comments' };
const pptTypes = { presentation: 'presentation.main', presProps: 'presProps', viewProps: 'viewProps', tableStyles: 'tableStyles', commentAuthors: 'commentAuthors' };
const rels = new Set(['officeDocument', 'styles', 'numbering', 'settings', 'fontTable', 'webSettings', 'header', 'footer', 'footnotes', 'endnotes', 'comments', 'theme', 'image', 'slide', 'slideMaster', 'slideLayout', 'notesSlide', 'notesMaster', 'presProps', 'viewProps', 'tableStyles', 'commentAuthors', 'extended-properties']);
const fail = () => { throw uploadError('conversion'); };
export const textEvidence = text => {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return { textHash: createHash('sha256').update(normalized).digest('hex'), textCharacters: normalized.length };
};
function parse(bytes, open, text = () => {}, close = () => {}) {
  const parser = new SaxesParser({ xmlns: true }); let depth = 0, nodes = 0;
  parser.on('doctype', fail); parser.on('processinginstruction', fail); parser.on('error', fail);
  parser.on('opentag', n => {
    if (++depth > 64 || ++nodes > 100000 || !namespaces.has(n.uri) || forbidden.test(n.local)) fail();
    const attrs = Object.create(null);
    for (const a of Object.values(n.attributes)) {
      if (a.uri === 'http://www.w3.org/2000/xmlns/') continue;
      if (a.uri === 'http://www.w3.org/XML/1998/namespace' && a.local === 'base'
        || a.uri === 'http://www.w3.org/2001/XMLSchema-instance' && ['schemaLocation', 'noNamespaceSchemaLocation'].includes(a.local)
        || /^(?:href|src|url|cmd)$/i.test(a.local)
        || a.local.toLowerCase() === 'uri' && !(n.uri === A && n.local === 'graphicData' && !a.uri && [`${O}drawingml/2006/picture`, `${O}drawingml/2006/table`].includes(a.value))) fail();
      if (a.uri && !namespaces.has(a.uri) && a.uri !== 'http://www.w3.org/XML/1998/namespace'
        && !(a.uri === inactiveIds && ['paraId', 'textId'].includes(a.local))) fail();
      attrs[a.name] = a.value;
    }
    open(n, attrs);
  });
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', n => { close(n); depth--; });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
}
function partType(path, kind) {
  if (path === '[Content_Types].xml') return 'manifest';
  if (path === '_rels/.rels' || /^(?:word|ppt)\/(?:[A-Za-z0-9_-]+\/)?_rels\/[A-Za-z0-9_-]+\.xml\.rels$/.test(path)) return 'application/vnd.openxmlformats-package.relationships+xml';
  if (path === 'docProps/core.xml') return 'application/vnd.openxmlformats-package.core-properties+xml';
  if (path === 'docProps/app.xml') return 'application/vnd.openxmlformats-officedocument.extended-properties+xml';
  const prefix = kind === 'docx_to_doc' ? 'word' : 'ppt';
  const media = ooxmlMediaType(path, prefix);
  if (media) return media;
  if (new RegExp(`^${prefix}/theme/theme[1-9][0-9]*\\.xml$`).test(path)) return 'application/vnd.openxmlformats-officedocument.theme+xml';
  if (prefix === 'word') {
    const name = /^word\/([A-Za-z]+)\.xml$/.exec(path)?.[1];
    if (Object.hasOwn(wordTypes, name)) return `application/vnd.openxmlformats-officedocument.wordprocessingml.${wordTypes[name]}+xml`;
    if (/^word\/(?:header|footer)[1-9][0-9]*\.xml$/.test(path)) return `application/vnd.openxmlformats-officedocument.wordprocessingml.${path.includes('/header') ? 'header' : 'footer'}+xml`;
  } else {
    const name = /^ppt\/([A-Za-z]+)\.xml$/.exec(path)?.[1];
    if (Object.hasOwn(pptTypes, name)) return `application/vnd.openxmlformats-officedocument.presentationml.${pptTypes[name]}+xml`;
    for (const part of ['slide', 'slideMaster', 'slideLayout', 'notesSlide', 'notesMaster', 'comment']) {
      if (new RegExp(`^ppt/${part}s/${part}[1-9][0-9]*\\.xml$`).test(path)) return `application/vnd.openxmlformats-officedocument.presentationml.${part === 'comment' ? 'comments' : part}+xml`;
    }
  }
  fail();
}
export function inspectOffice(bytes, name, mode) {
  try {
    if (!['docx_to_doc', 'pptx_to_slides'].includes(mode) || !(mode === 'docx_to_doc' ? /\.docx$/i : /\.pptx$/i).test(name)) fail();
    const files = readOoxmlZip(bytes), main = mode === 'docx_to_doc' ? 'word/document.xml' : 'ppt/presentation.xml';
    if (!files[main] || !files['[Content_Types].xml'] || !files['_rels/.rels']) fail();
    const defaults = new Map(), overrides = new Map(), relationships = new Map(), parts = new Map();
    parse(files['[Content_Types].xml'], (n, a) => {
      if (n.uri !== CT) fail();
      if (n.local === 'Default') { if (!a.Extension || defaults.has(a.Extension)) fail(); defaults.set(a.Extension, a.ContentType); }
      else if (n.local === 'Override') { if (!a.PartName?.startsWith('/') || overrides.has(a.PartName.slice(1))) fail(); overrides.set(a.PartName.slice(1), a.ContentType); }
      else if (n.local !== 'Types') fail();
    });
    for (const [path, content] of Object.entries(files)) {
      const type = partType(path, mode); parts.set(path, type);
      if (type === 'manifest') continue;
      if ((overrides.get(path) || defaults.get(path.split('.').at(-1))) !== type) fail();
      if (type.startsWith('image/')) {
        inspectOoxmlMedia(content, type);
        continue;
      }
      if (path.endsWith('.rels')) {
        const source = path === '_rels/.rels' ? '' : path.replace('/_rels/', '/').replace(/\.rels$/, '');
        if (source && !files[source]) fail();
        const list = new Map(); relationships.set(source, list);
        parse(content, (n, a) => {
          if (n.uri !== PKG) fail();
          if (n.local === 'Relationships') return;
          if (n.local !== 'Relationship' || !a.Id || list.has(a.Id) || a.TargetMode && a.TargetMode !== 'Internal'
            || !a.Target || /[\\%?#:]|\/\//.test(a.Target)) fail();
          const target = posix.normalize(a.Target.startsWith('/') ? a.Target.slice(1) : posix.join(posix.dirname(source), a.Target));
          if (target.startsWith('../') || !files[target]) fail();
          const rel = a.Type?.startsWith(`${R}/`) ? a.Type.slice(R.length + 1) : a.Type === `${O}package/2006/relationships/metadata/core-properties` ? 'core-properties' : '';
          if (rel !== 'core-properties' && !rels.has(rel)) fail();
          if (rel === 'officeDocument' && (source !== '' || target !== main)) fail();
          list.set(a.Id, { target, rel });
        });
      } else parse(content, () => {}); // inspect every XML part, even unreferenced
    }
    // Even unused declarations must not hide alternate/active content types.
    for (const [path, type] of overrides) if (parts.get(path) !== type) fail();
    for (const [ext, type] of defaults) if (!(ext === 'xml' && type === 'application/xml') && ![...parts].some(([path, expected]) => path.split('.').at(-1) === ext && expected === type)) fail();
    if ([...relationships.get('')?.values() || []].filter(r => r.rel === 'officeDocument' && r.target === main).length !== 1) fail();
    for (const [source, list] of relationships) for (const { rel, target } of list.values()) {
      const type = parts.get(target);
      const expectedType = rel === 'officeDocument' ? parts.get(main)
        : rel === 'core-properties' ? 'application/vnd.openxmlformats-package.core-properties+xml'
          : rel === 'extended-properties' ? 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
            : rel === 'theme' ? 'application/vnd.openxmlformats-officedocument.theme+xml'
              : `application/vnd.openxmlformats-officedocument.${mode === 'docx_to_doc' ? 'wordprocessingml' : 'presentationml'}.${rel}+xml`;
      if (rel === 'image' ? !type?.startsWith('image/') : type !== expectedType) fail();
      if (rel === 'slide' && (mode !== 'pptx_to_slides' || source !== main && !/^ppt\/notesSlides\/notesSlide[1-9][0-9]*\.xml$/.test(source))) fail();
    }
    // Relationships and their uses must agree too. No direct URI/link attribute
    // can bypass the relationship table, even in an otherwise passive XML part.
    for (const [path, content] of Object.entries(files)) if (path.endsWith('.xml') && path !== '[Content_Types].xml') parse(content, n => {
      for (const a of Object.values(n.attributes)) if (a.uri === R) {
        if (!['id', 'embed'].includes(a.local) || !relationships.get(path)?.has(a.value)) fail();
      }
    });
    function body(path, ns) {
      let text = '', inText = false, paragraphs = 0, tables = 0, images = 0;
      parse(files[path], n => {
        if (n.uri === ns && n.local === 't') inText = true;
        if (n.uri === ns && n.local === 'p') paragraphs++;
        if (n.local === 'tbl') tables++;
        if (n.uri === A && n.local === 'blip') images++;
        if (n.uri === W && ['tab', 'br', 'cr'].includes(n.local) || n.uri === A && n.local === 'br') text += ' ';
        if (n.uri === W && n.local === 'noBreakHyphen') text += '\u2011';
        if (n.uri === W && n.local === 'softHyphen') text += '\u00ad';
      }, t => { if (inText) { text += t; if (text.length > 40000) fail(); } }, n => {
        if (n.uri === ns && n.local === 't') inText = false;
        if (n.uri === ns && n.local === 'p') text += ' ';
      });
      return { ...textEvidence(text), paragraphs, tables, images };
    }
    if (mode === 'docx_to_doc') {
      let root = false, bodyCount = 0;
      parse(files[main], n => { if (n.uri === W && n.local === 'document') root = true; if (n.uri === W && n.local === 'body') bodyCount++; });
      if (!root || bodyCount !== 1) fail();
      return { kind: 'doc', body: body(main, W), inspection: 'Main-body text only; headers, footers, comments, notes and visual/object fidelity are not compared.' };
    }
    const slides = [], ids = new Set();
    parse(files[main], (n) => {
      if (n.uri === P && n.local === 'sldId') {
        const id = Object.values(n.attributes).find(a => a.uri === R && a.local === 'id')?.value;
        const rel = relationships.get(main)?.get(id);
        if (!id || ids.has(id) || rel?.rel !== 'slide' || !/^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(rel.target) || slides.includes(rel.target) || slides.length >= 100) fail();
        ids.add(id); slides.push(rel.target);
      }
    });
    if (!slides.length) fail();
    const evidence = slides.map(path => body(path, A));
    if (evidence.reduce((sum, p) => sum + p.textCharacters, 0) > 40000) fail();
    return { kind: 'slides', slides: evidence, inspection: 'Slide count/order and slide text only; notes, masters, media, animations and visual/object fidelity are not compared.' };
  } catch { throw uploadError('conversion'); }
}
