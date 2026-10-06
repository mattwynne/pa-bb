import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createDriveService, SCOPES } from '../core/service.mjs';

function fixture() {
  const store = createMemoryStore();
  const calls = [], diagnostics = [];
  const oauth = {
    authorizeUrl: props => { calls.push(['authorize', props]); return `https://accounts.google.com/?state=${props.state}`; },
    exchange: async props => { calls.push(['exchange', props]); return { access_token: 'private-access', refresh_token: 'private-refresh', scope: SCOPES.join(' '), expires_in: 3600 }; },
    identity: async () => ({ sub: 'sub-a', email: 'alice@example.test', email_verified: true }),
  };
  const drive = {
    identity: async record => ({ sub: record.subject, email: record.email }),
    listFiles: async (record, options) => { calls.push(['list', record.email, options]); return { files: [{ id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/f1/edit' }], nextPageToken: 'next' }; },
    getFile: async (record, id) => { calls.push(['get', record.email, id]); return { id, name: 'Notes', mimeType: 'application/vnd.google-apps.document' }; },
    readDoc: async (record, id) => { calls.push(['read', record.email, id]); return { title: 'Notes', tabs: [
      { documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First\n' } }] } }] } }, childTabs: [
        { documentTab: { body: { content: [{ table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Cell\n' } }] } }] }] }] } }] } } },
      ] },
    ] }; },
  };
  return { store, calls, diagnostics, oauth, drive, service: createDriveService({ store, oauth, drive, diagnose: (stage, error) => diagnostics.push({ stage, error }) }) };
}

test('OAuth uses verified identity, least-privilege scope, one-use state and isolated account records', async () => {
  const { service, store, calls } = fixture();
  const { url } = await service.beginConnect({ clientId: 'web-id', redirectUri: 'https://bb.example/api/v1/plugins/google-drive/http/callback' });
  const state = new URL(url).searchParams.get('state');
  assert.deepEqual(calls[0][1].scopes, SCOPES);
  assert.equal(calls[0][1].challenge.length > 30, true);
  assert.ok(!SCOPES.some(s => s.includes('calendar') || s.endsWith('/auth/drive')));
  const account = await service.finishConnect({ state, code: 'one-time', clientId: 'web-id', clientSecret: 'private', redirectUri: 'https://bb.example/api/v1/plugins/google-drive/http/callback' });
  assert.deepEqual(account, { subject: 'sub-a', email: 'alice@example.test' });
  assert.equal((await store.accounts())[0].refreshToken, 'private-refresh');
  await assert.rejects(() => service.finishConnect({ state, code: 'replay', clientId: 'web-id', clientSecret: 'private', redirectUri: 'https://bb.example/api/v1/plugins/google-drive/http/callback' }), /expired or is invalid/);
  assert.equal(calls.filter(c => c[0] === 'exchange').length, 1);
});

test('a missing read scope fails closed, consumes state, and stores no account', async () => {
  const { store, oauth, service } = fixture();
  oauth.exchange = async () => ({ access_token: 'private-access', refresh_token: 'private-refresh', scope: 'openid email' });
  const { url } = await service.beginConnect({ clientId: 'web-id', redirectUri: 'https://bb.example/callback' });
  const props = { state: new URL(url).searchParams.get('state'), code: 'private-code', clientId: 'web-id', clientSecret: 'private', redirectUri: 'https://bb.example/callback' };
  await assert.rejects(() => service.finishConnect(props), /required read-only Drive access/);
  await assert.rejects(() => service.finishConnect(props), /expired or is invalid/);
  assert.deepEqual(await store.accounts(), []);
});

test('searches names and indexed text, escapes Drive q, attributes accounts and exposes pagination', async () => {
  const { store, drive, calls, diagnostics, service } = fixture();
  await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'x' });
  await store.addAccount({ subject: 'b', email: 'bob@example.test', refreshToken: 'y' });
  drive.listFiles = async (record, options) => {
    calls.push(['list', record.email, options]);
    if (record.email === 'bob@example.test') throw Object.assign(new Error('private provider body'), { status: 503 });
    return { files: [{ id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' }], nextPageToken: 'next', incompleteSearch: true };
  };
  const result = await service.execute('gdrive_search_files', { query: "Matt's\\plan", foldersOnly: true });
  assert.equal(result.accounts.length, 2);
  assert.match(calls[0][2].q, /name contains 'Matt\\'s\\\\plan' or fullText contains 'Matt\\'s\\\\plan'/);
  assert.match(calls[0][2].q, /mimeType = 'application\/vnd.google-apps.folder'/);
  assert.equal(result.accounts[0].files[0].id, 'f1');
  assert.equal(result.accounts[0].incompleteSearch, true);
  assert.equal(result.accounts[0].nextPageToken, 'next');
  assert.deepEqual(result.accounts[1].error, { code: 'drive_unavailable' });
  assert.deepEqual(diagnostics.map(({ stage, error }) => [stage, error.status]), [['search_files', 503]]);
  await assert.rejects(() => service.execute('gdrive_search_files', { pageToken: 'next' }), /Select exactly one account/);
  assert.equal(calls.length, 2, 'invalid multi-account pagination must not make a provider request');
  const page = await service.execute('gdrive_search_files', { accounts: ['alice@example.test'], pageToken: 'next' });
  assert.equal(page.accounts.length, 1);
  assert.equal(calls.at(-1)[2].pageToken, 'next');
});

test('explicit account and file IDs are required; Docs reads include nested tabs and report unsupported files', async () => {
  const { store, drive, calls, service } = fixture();
  await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'x' });
  assert.deepEqual((await service.execute('gdrive_list_folder', { account: 'alice@example.test', folderId: 'root' })).files.map(f => f.id), ['f1']);
  assert.match(calls[0][2].q, /'root' in parents/);
  const doc = await service.execute('gdocs_read', { account: 'alice@example.test', document: 'https://docs.google.com/document/d/f1/edit' });
  assert.match(doc.text, /First\nCell\n/);
  assert.equal(doc.url, 'https://docs.google.com/document/d/f1/edit');
  assert.equal(doc.truncated, false);
  assert.equal(doc.account, 'alice@example.test');
  await assert.rejects(() => service.execute('gdocs_read', { account: 'nobody@example.test', document: 'f1' }), /Unknown Google Drive account/);
  await assert.rejects(() => service.execute('gdocs_read', { account: 'alice@example.test', document: 'https://evil.example/document/d/f1/edit' }), /Use a Google Docs URL/);
  drive.getFile = async () => ({ id: 'f2', mimeType: 'application/pdf' });
  await assert.rejects(() => service.execute('gdocs_read', { account: 'alice@example.test', document: 'f2' }), /not a Google Doc/);
  assert.equal(calls.filter(c => c[0] === 'read').length, 1);
  drive.getFile = async () => ({ id: 'large', name: 'Long', mimeType: 'application/vnd.google-apps.document' });
  drive.readDoc = async () => ({ body: { content: [{ paragraph: { elements: [{ textRun: { content: 'x'.repeat(100_001) } }] } }] } });
  const long = await service.execute('gdocs_read', { account: 'alice@example.test', document: 'large' });
  assert.equal(long.text.length, 100_000);
  assert.equal(long.truncated, true);
});
