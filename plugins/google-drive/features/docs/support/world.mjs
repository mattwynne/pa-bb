// Side-effect-free on import: real services/Google adapter/SQLite, closed HTTP only.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../../../adapters/bb-store.mjs';
import { createGoogleAdapter } from '../../../adapters/google.mjs';
import { createDocsFormatService } from '../../../core/docs-format.mjs';
import { createDocsEditService } from '../../../core/docs-edit.mjs';
import { failureCategory } from '../../../diagnostic.mjs';

export const account = 'writer@example.test';
export const key = '11111111-1111-4111-8111-111111111111';
export const formatArgs = { account, document: 'doc-a', operationId: key, expectedRevisionId: 'rev-a', preview: false,
  ranges: [{ tabId: 'tab-a', startIndex: 1, endIndex: 6, textStyle: { bold: true } }] };
export const replaceArgs = { account, document: 'doc-a', expectedRevisionId: 'rev-a', preview: false, tabId: 'tab-a', oldText: 'Text', newText: '' };
const record = { subject: 'subject-a', email: account, refreshToken: 'PRIVATE_REFRESH', accessToken: 'PRIVATE_TOKEN', expiresAt: 9_000_000 };
const before = { documentId: 'doc-a', revisionId: 'rev-a', suggestionsViewMode: 'SUGGESTIONS_INLINE', title: 'PRIVATE_TITLE', tabs: [
  { tabProperties: { tabId: 'tab-a', title: 'Main' }, documentTab: { body: { content: [
    { endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 6, paragraph: { elements: [{ startIndex: 1, endIndex: 6, textRun: { content: 'Text\n' } }] } },
  ] } } },
] };
const formatAfter = structuredClone(before);
formatAfter.revisionId = 'rev-b';
formatAfter.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle = { bold: true };
const replaceAfter = structuredClone(before);
replaceAfter.revisionId = 'rev-b';
replaceAfter.tabs[0].documentTab.body.content[1] = { startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } };
export function barrier() {
  let enter, release;
  const reached = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, release, wait: async () => { enter(); await resumed; } };
}
export class DocsWorld {
  async init(fault = 'none') {
    this.fault = fault; this.now = 0; this.policy = false; this.authCount = 0; this.calls = []; this.logs = []; this.unexpected = [];
    this.doc = structuredClone(before); this.controller = new AbortController(); this.approvals = 0;
    this.host = createFakePluginHost({ pluginId: 'docs-s00-fixture' });
    this.openStore();
    await this.store.addAccount(record);
    const update = this.store.updateFormatting.bind(this.store);
    this.store.updateFormatting = async op => {
      if (fault === 'storage' && this.mutations.length) throw Object.assign(new Error('PRIVATE_STORAGE'), { cause: 'PRIVATE_CAUSE', docsCode: 'authorization_failed', docsWriteAttempted: false });
      return update(op);
    };
    this.compose();
  }
  openStore() {
    const db = this.host.bb.storage.database();
    assert.notEqual(db.name, ':memory:'); assert.ok(existsSync(db.name));
    this.databasePath = db.name;
    this.store = createBbStore(db, this.host.bb.storage.migrate);
  }
  compose() {
    const adapter = createGoogleAdapter({ store: this.store, clock: () => this.now,
      getClient: async () => { throw new Error('Unexpected refresh'); }, fetchImpl: this.fetch.bind(this) });
    const ports = { store: this.store, drive: adapter.drive, docs: adapter.docs, clock: () => this.now,
      approvalRequired: async () => this.policy,
      approve: async () => { this.approvals++; return { outcome: 'submitted', value: { approved: true } }; },
      diagnose: (stage, error) => this.logs.push(`Google Drive ${stage} ${failureCategory(error)}`) };
    this.ports = ports;
    this.format = createDocsFormatService(ports); this.edit = createDocsEditService(ports);
  }
  get mutations() { return this.calls.filter(c => c.url.endsWith(':batchUpdate')); }
  async fetch(url, init = {}) {
    url = String(url); const method = init.method || 'GET';
    this.calls.push({ url, method, ...(url.endsWith(':batchUpdate') ? { body: JSON.parse(init.body) } : {}) });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo' && method === 'GET')
      return Response.json({ sub: 'subject-a', email: account, email_verified: true });
    if (url === 'https://oauth2.googleapis.com/tokeninfo' && method === 'POST') {
      this.authCount++;
      if (this.authCount === 2) await this.finalAuth?.();
      if (this.fault === 'auth403' || (this.fault === 'finalAuth403' && this.authCount === 2)) return new Response('PRIVATE_PROVIDER_BODY', { status: 403 });
      return Response.json({ scope: 'https://www.googleapis.com/auth/documents' });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/doc-a?') && method === 'GET') {
      if (this.mutations.length && this.fault === 'metadata403') return new Response('PRIVATE_PROVIDER_BODY', { status: 403 });
      return Response.json({ id: 'doc-a', mimeType: 'application/vnd.google-apps.document', trashed: false });
    }
    if (url === 'https://docs.googleapis.com/v1/documents/doc-a?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE' && method === 'GET') {
      if (this.mutations.length && ['docs403', 'storage'].includes(this.fault)) return new Response('PRIVATE_PROVIDER_BODY', { status: 403 });
      return Response.json(this.doc);
    }
    if (url === 'https://docs.googleapis.com/v1/documents/doc-a:batchUpdate' && method === 'POST') {
      const body = JSON.parse(init.body);
      const replacement = !!body.requests[0]?.replaceAllText;
      try { assert.deepEqual(body, { writeControl: { requiredRevisionId: 'rev-a' }, requests: replacement
        ? [{ replaceAllText: { containsText: { text: 'Text', matchCase: true, searchByRegex: false }, replaceText: '', tabsCriteria: { tabIds: ['tab-a'] } } }]
        : [{ updateTextStyle: { range: { tabId: 'tab-a', startIndex: 1, endIndex: 6 }, textStyle: { bold: true }, fields: 'bold' } }] }); }
      catch (error) { this.unexpected.push({ wire: 'invalid batch' }); throw error; }
      if (this.fault === 'reject403' || this.fault === 'reject400') return new Response('PRIVATE_PROVIDER_BODY', { status: this.fault === 'reject403' ? 403 : 400 });
      if (this.fault === 'lost') throw new Error('PRIVATE_RESPONSE_LOST');
      this.doc = structuredClone(replacement ? replaceAfter : formatAfter);
      return Response.json({ documentId: 'doc-a', replies: replacement ? [{ replaceAllText: { occurrencesChanged: 1 } }] : [{}], writeControl: { requiredRevisionId: 'rev-b' } });
    }
    this.unexpected.push({ url, method }); throw new Error('Closed fixture: unexpected HTTP');
  }
  async apply(kind = 'format') {
    this.result = kind === 'format' ? await this.format.format(formatArgs, this.controller.signal)
      : await this.edit.replace(replaceArgs, this.controller.signal);
    return this.result;
  }
  async change(change) {
    if (change === 'policy') this.policy = true;
    else if (change === 'cancel') this.controller.abort(new Error('PRIVATE_CANCEL'));
    else if (change === 'expiry') this.now = 600_001;
    else if (change === 'account' || change === 'subject') {
      await this.store.removeAccount('subject-a');
      if (change === 'subject') await this.store.addAccount({ ...record, subject: 'subject-b' });
    } else throw new Error('Unknown fixture change');
  }
  async reopen() {
    this.host.bb.storage.database().close();
    this.openStore(); this.compose();
  }
  async recover() {
    const start = this.calls.length;
    this.status = await this.format.status({ account, operationId: key });
    assert.ok(this.calls.slice(start).every(c => c.method === 'GET'), 'recovery must only read Google');
    return this.status;
  }
  async close() {
    await this.host?.harness.lifecycle.dispose();
    assert.deepEqual(this.unexpected, []);
  }
}
