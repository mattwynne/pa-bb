import { randomBytes } from 'node:crypto';

const DOCUMENT = 'application/vnd.google-apps.document';
const MAX_TEXT = 100_000;
const MAX_SERIALIZED = 200_000;
const MAX_SNAPSHOT_BYTES = 16 * 1_048_576;
const MAX_SESSIONS = 4;
const SNAPSHOT_MS = 5 * 60_000;
const cursorError = () => Object.assign(new Error('This Docs continuation is unavailable. Start a fresh read.'), { code: 'docs_cursor_expired' });
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
};
function textFromElements(elements) {
  let result = '';
  for (const item of elements || []) {
    if (item.paragraph) for (const part of item.paragraph.elements || []) result += part.textRun?.content || '';
    if (item.table) for (const row of item.table.tableRows || []) for (const cell of row.tableCells || []) result += textFromElements(cell.content) + '\t';
    if (item.tableOfContents) result += textFromElements(item.tableOfContents.content);
  }
  return result;
}
function textFromTabs(tabs) {
  let result = '';
  for (const tab of tabs || []) {
    if (!tab || !tab.documentTab || (tab.childTabs !== undefined && !Array.isArray(tab.childTabs)))
      throw Object.assign(new Error('Docs tabs could not be read completely.'), { code: 'docs_read_incomplete' });
    if (tab.documentTab?.body?.content) result += textFromElements(tab.documentTab.body.content);
    result += textFromTabs(tab.childTabs);
  }
  return result;
}

// Read-only ports provide account resolution, metadata and the bounded Docs response.
export function createDocsReader({ account, getFile, readDocument, clock = () => Date.now() }) {
  // Snapshots are ephemeral, bounded and never persisted. A timer clears abandoned
  // reads even when no further tool call arrives.
  const reads = new Map();
  let stopped = false, generation = 0;
  function clearReads() { generation++; for (const session of reads.values()) clearTimeout(session.timer); reads.clear(); }
  function dispose() { stopped = true; clearReads(); }
  function take(cursor) {
    const session = reads.get(cursor);
    if (!session) throw cursorError();
    reads.delete(cursor); clearTimeout(session.timer);
    if (stopped || clock() >= session.expiresAt) throw cursorError();
    return session;
  }
  function issue(session) {
    for (const [key, existing] of reads) if (clock() >= existing.expiresAt) { clearTimeout(existing.timer); reads.delete(key); }
    if (stopped || clock() >= session.expiresAt) throw cursorError();
    if (reads.size >= MAX_SESSIONS || [...reads.values()].reduce((n, s) => n + s.bytes, 0) + session.bytes > MAX_SNAPSHOT_BYTES)
      throw Object.assign(new Error('Docs read capacity is full. Finish an active read or start again later.'), { code: 'docs_read_capacity' });
    const cursor = randomBytes(32).toString('base64url');
    session.timer = setTimeout(() => reads.delete(cursor), Math.max(1, session.expiresAt - clock()));
    session.timer.unref?.();
    reads.set(cursor, session);
    return cursor;
  }
  async function readDoc(args, reader = '') {
    const input = required(args.document, 'document');
    let id = input;
    if (/^https:\/\//.test(input)) {
      const url = new URL(input);
      if (url.hostname !== 'docs.google.com' || !/^\/document\/d\/[a-zA-Z0-9_-]+(?:\/|$)/.test(url.pathname)) throw new Error('Use a Google Docs URL or document ID');
      id = url.pathname.split('/')[3];
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Use a Google Docs URL or document ID');
    const readGeneration = generation;
    let record;
    try { record = await account(args.account); }
    catch (error) { if (args.cursor !== undefined && error?.message === 'Unknown Google Drive account. Check connected accounts in BB settings.') throw cursorError(); throw error; }
    if (stopped || readGeneration !== generation) throw cursorError();
    // Claim after account lookup and before any further await. Replays cannot advance it.
    let session = args.cursor === undefined ? null : take(required(args.cursor, 'cursor'));
    if (session && (session.subject !== record.subject || session.id !== id || session.reader !== reader)) throw cursorError();
    if (!session) {
      const metadata = await getFile(record, id);
      if (metadata.mimeType !== DOCUMENT) throw new Error('This file is not a Google Doc; reading other formats is not supported yet');
      const doc = await readDocument(record, id);
      if (stopped || generation !== readGeneration) throw cursorError();
      if ((!doc.tabs?.length && !doc.body) || (doc.tabs !== undefined && !Array.isArray(doc.tabs))) throw Object.assign(new Error('Docs tabs could not be read completely.'), { code: 'docs_read_incomplete' });
      const text = doc.tabs?.length ? textFromTabs(doc.tabs) : textFromElements(doc.body?.content);
      session = { subject: record.subject, reader, id, text, offset: 0, expiresAt: clock() + SNAPSHOT_MS,
        bytes: Buffer.byteLength(text, 'utf16le') + Buffer.byteLength(String(doc.title || metadata.name || ''), 'utf16le') + Buffer.byteLength(String(metadata.webViewLink || ''), 'utf16le'), account: record.email, title: doc.title || metadata.name,
        url: metadata.webViewLink || `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit` };
    }
    if (clock() >= session.expiresAt || stopped) throw cursorError();
    const start = session.offset;
    let end = Math.min(start + MAX_TEXT, session.text.length);
    const boundary = at => at > start && /[\uD800-\uDBFF]/.test(session.text[at - 1]) && /[\uDC00-\uDFFF]/.test(session.text[at] || '') ? at - 1 : at;
    end = boundary(end);
    const result = at => ({ account: session.account, documentId: id, title: session.title, url: session.url,
      text: session.text.slice(start, at), truncated: at < session.text.length, offset: start, nextOffset: at,
      totalChars: session.text.length, complete: at === session.text.length, nextCursor: at < session.text.length ? 'x'.repeat(43) : null });
    while (JSON.stringify(result(end)).length > MAX_SERIALIZED && end > start) end = boundary(start + Math.floor((end - start) / 2));
    if (JSON.stringify(result(end)).length > MAX_SERIALIZED || (end === start && start < session.text.length))
      throw Object.assign(new Error('Docs read output exceeds the supported size.'), { code: 'docs_read_capacity' });
    const page = result(end);
    if (page.truncated) { session.offset = end; page.nextCursor = issue(session); }
    return page;
  }
  return { read: readDoc, invalidate: clearReads, dispose };
}
