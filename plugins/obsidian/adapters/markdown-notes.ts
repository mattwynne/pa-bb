import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument, isMap, isScalar, isSeq } from 'yaml';
import type { Document } from 'yaml';
import { VaultError } from '../core/ports.ts';
import type { Metadata, NoteParser } from '../core/ports.ts';
const MAX_BYTES = 64 * 1024; const MAX_NODES = 20000;
const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
const walk = (node: any, visit: (node: any) => void, depth = 0) => { if (depth > 64) throw new VaultError('parser_limit'); visit(node); for (const child of node.children ?? []) walk(child, visit, depth + 1); };
function header(text: string): { start: number; end: number; closeEnd: number; yaml: string; doc: Document | null; valid: boolean } {
  const open = /^(?:\uFEFF)?---\r?\n/.exec(text);
  if (!open) return { start: 0, end: 0, closeEnd: 0, yaml: '', doc: null, valid: true };
  const close = /^---[ \t]*\r?$/gm; close.lastIndex = open[0].length; const found = close.exec(text);
  if (!found) return { start: open[0].length, end: text.length, closeEnd: text.length, yaml: '', doc: null, valid: false };
  const yaml = text.slice(open[0].length, found.index);
  try {
    if (yaml.length > 65536) throw new Error();
    const doc = parseDocument(yaml, { schema: 'core', uniqueKeys: true, keepSourceTokens: true, version: '1.2', strict: true });
    if (doc.errors.length || doc.warnings.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error();
    // No aliases, custom tags, merges, nested maps or executable constructors.
    for (const pair of (isMap(doc.contents) ? doc.contents.items : [])) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.key.value || /[\x00-\x1f]/.test(pair.key.value)) throw new Error();
      const node = pair.value;
      if (node && !(isScalar(node) || (isSeq(node) && node.items.every(item => isScalar(item))))) throw new Error();
      if (node?.tag || pair.key.tag || (isSeq(node) && node.items.some(item => (item as any)?.tag))) throw new Error();
    }
    const properties = doc.toJS({ maxAliasCount: 0 }) ?? {}; validateProperties(properties);
    return { start: open[0].length, end: found.index, closeEnd: found.index + found[0].length + (text[found.index + found[0].length] === '\n' ? 1 : 0), yaml, doc, valid: true };
  } catch { return { start: open[0].length, end: found.index, closeEnd: found.index + found[0].length + 1, yaml, doc: null, valid: false }; }
}
function validateProperties(properties: Record<string, unknown>) {
  for (const [key, value] of Object.entries(properties)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !key || /[\r\n\x00]/.test(key)) throw new VaultError('properties_unsupported');
    const scalar = (v: unknown) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    if (!scalar(value) && !(Array.isArray(value) && value.length <= 256 && value.every(scalar))) throw new VaultError('properties_unsupported');
    if (['tags', 'aliases', 'cssclasses'].includes(key) && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) throw new VaultError('properties_unsupported');
    if (key === 'tags' && (value as string[]).some(v => !validTag(v.replace(/^#/, '')))) throw new VaultError('properties_unsupported');
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
      const date = value.slice(0, 10); const parsed = new Date(date + 'T00:00:00Z');
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || (value.length > 10 && !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value))) throw new VaultError('properties_unsupported');
    }
  }
}
const validTag = (tag: string) => !!tag && /^[\p{L}\p{N}\p{M}\p{S}_\-/]+$/u.test(tag) && /[^\p{N}]/u.test(tag) && !tag.includes('//') && !tag.startsWith('/') && !tag.endsWith('/');
export class MarkdownNotes implements NoteParser {
  edit = editText;
  properties = updateProperties;
  frontmatter(text: string) {
    const value = header(text);
    return { properties: value.doc?.toJS({ maxAliasCount: 0 }) ?? {}, warnings: value.valid ? [] : ['properties_unsupported'] };
  }
  parse(text: string): Metadata {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new VaultError('parser_limit');
    const meta: Metadata = { properties: {}, aliases: [], tags: [], headings: [], blocks: [], links: [], tasks: [], warnings: [] };
    const h = header(text); let masked = blank(text.slice(0, h.closeEnd)) + text.slice(h.closeEnd);
    if (!h.valid) meta.warnings.push('properties_unsupported');
    if (h.doc) { meta.properties = h.doc.toJS({ maxAliasCount: 0 }) ?? {}; meta.aliases = (meta.properties.aliases as string[] | undefined) ?? []; }
    const location = (start: number, end: number) => ({ start, end, line: lineAt(text, start), endLine: lineAt(text, Math.max(start, end - 1)) });
    const forbidden: Array<[number, number]> = []; let nodes = 0;
    const html: Array<{ start: number; end: number; value: string }> = [];
    walk(fromMarkdown(masked), node => { if (++nodes > MAX_NODES) throw new VaultError('parser_limit'); if (['code', 'inlineCode', 'html'].includes(node.type)) forbidden.push([node.position.start.offset, node.position.end.offset]); if (node.type === 'html') html.push({ start: node.position.start.offset, end: node.position.end.offset, value: node.value }); });
    const inCode = (at: number) => forbidden.some(([start, end]) => at >= start && at < end);
    // Mask comments without changing source offsets. Markers inside real code
    // spans/blocks and HTML never start Obsidian comments.
    const chars = masked.split('');
    for (let at = 0; at < masked.length - 1; at++) if (masked.slice(at, at + 2) === '%%' && masked[at - 1] !== '\\' && !inCode(at)) {
      const close = masked.indexOf('%%', at + 2); const end = close < 0 ? masked.length : close + 2;
      for (let i = at; i < end; i++) if (chars[i] !== '\r' && chars[i] !== '\n') chars[i] = ' ';
      at = end - 1;
    }
    // Inline HTML contents are evidence in raw reads, but never extracted as
    // Markdown semantics. Conservatively mask a matched HTML region as well.
    const stack: Array<{ tag: string; start: number }> = [];
    const ranges = html.map(region => ({ start: region.start, end: region.end }));
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const region of html) {
      const opening = /^<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>$/.exec(region.value);
      const closing = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(region.value);
      if (opening && !voidTags.has(opening[1].toLowerCase()) && !region.value.endsWith('/>')) {
        if (stack.length >= 64) throw new VaultError('parser_limit');
        stack.push({ tag: opening[1].toLowerCase(), start: region.start });
      } else if (closing) {
        let index = stack.length - 1; while (index >= 0 && stack[index].tag !== closing[1].toLowerCase()) index--;
        if (index >= 0) { ranges.push({ start: stack[index].start, end: region.end }); stack.splice(index); }
      }
    }
    if (stack.length) { meta.warnings.push('unclosed_html'); for (const item of stack) ranges.push({ start: item.start, end: masked.length }); }
    for (const region of ranges) for (let at = region.start; at < region.end; at++) if (chars[at] !== '\r' && chars[at] !== '\n') chars[at] = ' ';
    masked = chars.join(''); nodes = 0;
    const root = fromMarkdown(masked);
    const textOf = (node: any): string => node.value ?? (node.children ?? []).map(textOf).join('');
    walk(root, node => {
      if (++nodes > MAX_NODES) throw new VaultError('parser_limit');
      if (!node.position) return;
      const start = node.position.start.offset; const end = node.position.end.offset;
      if (node.type === 'heading') meta.headings.push({ ...location(start, end), title: textOf(node), depth: node.depth });
      if (node.type === 'link' || node.type === 'image') meta.links.push({ ...location(start, end), target: node.url, embed: node.type === 'image' });
      if (node.type === 'text') {
        const source = masked.slice(start, end);
        for (const match of source.matchAll(/!?\[\[([^\]\r\n]+)\]\]/g)) if (source[(match.index ?? 0) - 1] !== '\\') meta.links.push({ ...location(start + match.index!, start + match.index! + match[0].length), target: match[1].split('|')[0], embed: match[0].startsWith('!') });
        for (const match of source.matchAll(/(^|[\s(])#([^\s#.,;:!?()[\]{}<>"'`]+)/gu)) {
          const tag = match[2]; if (validTag(tag)) { const at = start + match.index! + match[1].length; meta.tags.push({ ...location(at, at + tag.length + 1), tag: tag.toLocaleLowerCase('und') }); }
        }
        for (const match of source.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/gm)) {
          let blockStart = start; if (!source.slice(0, match.index).trim()) {
            const previous = (root.children as any[]).filter(n => n.position.end.offset < start && !['html', 'code'].includes(n.type)).at(-1); blockStart = previous?.position.start.offset ?? start;
          }
          meta.blocks.push({ ...location(blockStart, end), id: match[1] });
        }
      }
      if (node.type === 'listItem' && node.children?.[0]?.type === 'paragraph') {
        const paragraph = node.children[0]; const offset = paragraph.position.start.offset; const content = masked.slice(offset, paragraph.position.end.offset);
        const match = /^\[([^\]\r\n])\][ \t]+([^\r\n]*)/u.exec(content);
        if (match) meta.tasks.push({ ...location(offset, offset + match[0].length), marker: match[1], markerOffset: offset + 1, complete: match[1].trim() !== '', text: text.slice(offset + match[0].length - match[2].length, offset + match[0].length) });
      }
    });
    if (h.doc && isMap(h.doc.contents)) for (const pair of h.doc.contents.items) {
      const value = pair.value; const start = h.start + ((value as any)?.range?.[0] ?? 0); const end = h.start + ((value as any)?.range?.[1] ?? 0);
      if ((pair.key as any).value === 'tags') for (const tag of meta.properties.tags as string[]) meta.tags.push({ ...location(start, end), tag: tag.replace(/^#/, '').toLocaleLowerCase('und') });
      const strings = isSeq(value) ? value.items.map(v => (v as any)?.value) : [(value as any)?.value];
      for (const value of strings) if (typeof value === 'string') for (const match of value.matchAll(/!?\[\[([^\]]+)\]\]/g)) meta.links.push({ ...location(start, end), target: match[1].split('|')[0], embed: match[0].startsWith('!') });
    }
    return meta;
  }
}
function assertWritable(text: string) { if (!header(text).valid) throw new VaultError('properties_unsupported'); }
export function editText(text: string, replacements: Array<{ oldText: string; newText: string }>) {
  assertWritable(text); const edits = replacements.map(change => { const at = text.indexOf(change.oldText); if (!change.oldText || at < 0 || text.indexOf(change.oldText, at + 1) >= 0) throw new VaultError('ambiguous_edit'); return { ...change, at, end: at + change.oldText.length }; }).sort((a, b) => a.at - b.at);
  for (let i = 1; i < edits.length; i++) if (edits[i].at < edits[i - 1].end) throw new VaultError('overlapping_edits');
  let next = text; for (const edit of edits.reverse()) next = next.slice(0, edit.at) + edit.newText + next.slice(edit.end);
  assertWritable(next); return next;
}
export function updateProperties(text: string, input: { set: Record<string, unknown>; remove: string[] }) {
  assertWritable(text); validateProperties(input.set);
  if (Object.keys(input.set).some(key => input.remove.includes(key)) || new Set(input.remove).size !== input.remove.length) throw new VaultError('ambiguous_edit');
  const h = header(text); const eol = text.includes('\r\n') ? '\r\n' : '\n'; const scalar = (value: unknown) => typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  if (!h.doc) { if (!Object.keys(input.set).length) return text; return `---${eol}${Object.entries(input.set).map(([key, value]) => `${/^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key)}: ${scalar(value)}${eol}`).join('')}---${eol}${text}`; }
  const changes: Array<{ start: number; end: number; value: string }> = [];
  const remaining = new Map(Object.entries(input.set));
  for (const pair of (isMap(h.doc.contents) ? h.doc.contents.items : []) as any[]) {
    const key = pair.key.value; const node = pair.value;
    if (input.remove.includes(key)) {
      const start = h.start + pair.key.range[0]; const nodeEnd = h.start + (node?.range?.[2] ?? pair.key.range[2]); const newline = text.indexOf('\n', Math.max(start, nodeEnd - 1));
      changes.push({ start, end: newline < 0 ? nodeEnd : newline + 1, value: '' });
    } else if (remaining.has(key)) {
      if (!node?.range) throw new VaultError('properties_unsupported');
      let value = scalar(remaining.get(key)); const old = text.slice(h.start + node.range[0], h.start + node.range[1]);
      if (old.endsWith('\n')) value += eol;
      changes.push({ start: h.start + node.range[0], end: h.start + node.range[1], value }); remaining.delete(key);
    }
  }
  if (remaining.size) changes.push({ start: h.end, end: h.end, value: [...remaining].map(([key, value]) => `${/^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key)}: ${scalar(value)}${eol}`).join('') });
  let next = text; for (const change of changes.sort((a, b) => b.start - a.start)) next = next.slice(0, change.start) + change.value + next.slice(change.end);
  assertWritable(next); return next;
}
