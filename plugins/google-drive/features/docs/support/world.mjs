// Side-effect-free on import: real services/Google adapter/SQLite, closed HTTP only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { WireSimulator } from './wire-simulator.mjs';
import { validateRequest } from '../coverage/wire.mjs';
const vectors = JSON.parse(readFileSync(new URL('../coverage/fixtures/legacy-vectors.json', import.meta.url)));
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
const before = vectors.before;
export function barrier() {
  let enter, release;
  const reached = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, release, wait: async () => { enter(); await resumed; } };
}
export class DocsWorld {
  constructor(options = {}) { this.attach = options.attach; this.boundaries = new Set(); }
  set asset(boundary) { this._asset = boundary; if (boundary) this.boundaries.add(boundary); }
  get asset() { return this._asset; }
  acknowledgeHttpFault(expected) {
    assert.deepEqual(this.unexpected, [expected], 'only the exact asserted HTTP fault may be acknowledged');
    this.unexpected.shift();
  }
  async init(fault = 'none') {
    assert.deepEqual(this.unexpected ?? [], [], 'initialization cannot discard an HTTP fixture fault');
    this.fault = fault; this.now = 0; this.policy = false; this.authCount = 0; this.calls = []; this.logs = []; this.unexpected = [];
    this.doc = structuredClone(before); this.simulator = new WireSimulator(before); this.controller = new AbortController(); this.approvals = 0;
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
    const call = { url, method }; this.calls.push(call);
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo' && method === 'GET')
      return Response.json({ sub: 'subject-a', email: account, email_verified: true });
    if (url === 'https://oauth2.googleapis.com/tokeninfo' && method === 'POST') {
      this.authCount++;
      if (this.authCount === 2) await this.finalAuth?.();
      if (this.fault === 'auth403' || (this.fault === 'finalAuth403' && this.authCount === 2)) return new Response('PRIVATE_PROVIDER_BODY', { status: 403 });
      return Response.json({ scope: 'https://www.googleapis.com/auth/documents' });
    }
    if (url === 'https://www.googleapis.com/drive/v3/files/doc-a?fields=id%2Cname%2CmimeType%2Cdescription%2CmodifiedTime%2Cparents%2CwebViewLink%2Ctrashed%2CdriveId%2CappProperties%2Ccapabilities%28canCopy%2CcanAddChildren%29&supportsAllDrives=true' && method === 'GET') {
      if (this.mutations.length && this.fault === 'metadata403') return new Response('PRIVATE_PROVIDER_BODY', { status: 403 });
      return Response.json({ id: 'doc-a', mimeType: 'application/vnd.google-apps.document', trashed: false });
    }
    if (url === 'https://docs.googleapis.com/v1/documents/doc-a?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE' && method === 'GET') {
      if (this.mutations.length && ['docs403', 'storage'].includes(this.fault)) return new Response('PRIVATE_PROVIDER_BODY', { status: 403 });
      return Response.json(this.doc);
    }
    if (url === 'https://docs.googleapis.com/v1/documents/doc-a:batchUpdate' && method === 'POST') {
      let body, replacement;
      try {
        // One contract boundary, including decoding and the first dereference.
        // This fixture intentionally supports only its two single-request vectors.
        body = JSON.parse(init.body); call.body = body;
        assert.ok(body && typeof body === 'object' && !Array.isArray(body), 'batch object');
        assert.ok(Array.isArray(body.requests) && body.requests.length === 1, 'one fixture request required');
        for (const request of body.requests) {
          assert.ok(request && typeof request === 'object' && !Array.isArray(request), 'request object');
          validateRequest(request);
        }
        replacement = Object.hasOwn(body.requests[0], 'replaceAllText');
        assert.deepEqual(body, vectors[replacement ? 'replace' : 'format'].request);
      }
      catch (error) { this.unexpected.push({ wire: 'invalid batch' }); throw error; }
      if (this.fault === 'reject403' || this.fault === 'reject400') return new Response('PRIVATE_PROVIDER_BODY', { status: this.fault === 'reject403' ? 403 : 400 });
      if (this.fault === 'lost') throw new Error('PRIVATE_RESPONSE_LOST');
      let reply;
      try {
        reply = this.simulator.submit(body);
        this.doc = structuredClone(this.simulator.document);
        assert.deepEqual(this.doc, vectors[replacement ? 'replace' : 'format'].after, 'independent complete readback/preservation');
      } catch (error) { this.unexpected.push({ wire: 'simulator contract' }); throw error; }
      if (this.fault === 'appliedLost') throw new Error('PRIVATE_APPLIED_RESPONSE_LOST');
      return Response.json(reply);
    }
    this.unexpected.push({ url, method }); throw new Error('Closed fixture: unexpected HTTP');
  }
  async apply(kind = 'format') {
    this.driver = kind === 'format' ? 'createDocsFormatService.format' : 'createDocsEditService.replace';
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
    const failures = [];
    try {
      try { assert.deepEqual(this.unexpected ?? [], [], 'unacknowledged HTTP fixture fault'); } catch (error) { failures.push(error); }
      for (const boundary of this.boundaries) try { boundary.check(); } catch (error) { failures.push(error); }
    } finally {
      try { await this.host?.harness.lifecycle.dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'closed-network teardown failed');
  }
}
