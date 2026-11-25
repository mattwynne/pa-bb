import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, recWorld, TENANT, ACCOUNT } from './bank-rec-fixture.mjs';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('append-only capture migration preserves the original schema and pending authorization', async () => {
  const host = createFakePluginHost({ pluginId: 'xero' }); const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [`CREATE TABLE xero_session (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
    CREATE TABLE xero_pending (hash TEXT PRIMARY KEY, value TEXT NOT NULL);`]);
  db.prepare('INSERT INTO xero_pending (hash,value) VALUES (?,?)').run('old-hash', 'SECRET_OLD_PENDING');
  try { await plugin(host.bb); assert.equal(db.prepare('SELECT value FROM xero_pending WHERE hash=?').get('old-hash').value, 'SECRET_OLD_PENDING'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM xero_bank_rec_captures').get().n, 0); }
  finally { await host.harness.lifecycle.dispose(); }
});

test('disconnect during account verification cannot commit a stale capture import', async () => {
  const w = await recWorld(); let release, enter; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  w.beforeAccounts(async () => { enter(); await held; });
  try {
    const pending = w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify(capture()) }); await entered; await w.rpc('disconnect'); release();
    assert.equal((await pending).ok, false); assert.equal(w.host.bb.storage.database().prepare('SELECT COUNT(*) AS n FROM xero_bank_rec_captures').get().n, 0);
  } finally { release(); await w.close(); }
});
test('built BB imports only verified membership/currency, preserves duplicates/history, paginates lines and deduplicates file imports', async () => {
  const w = await recWorld();
  try {
    const one = capture(), json = JSON.stringify(one), first = await w.rpc('bankRecImport', { tenantId: TENANT, json });
    assert.equal(first.ok, true); assert.equal(first.outcome, 'imported'); assert.equal(first.capture.lineCount, 2);
    const same = await w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify(one, null, 2) }); assert.equal(same.outcome, 'already_imported'); assert.equal(same.capture.id, first.capture.id);
    const older = await w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify({ ...one, capturedAt: new Date(Date.now() - 3600_000).toISOString() }) }); assert.equal(older.ok, true);
    const list = await w.rpc('bankRecList', { tenantId: TENANT }); assert.equal(list.total, 2); assert.equal(list.captures[0].id, first.capture.id);
    const read = await w.host.harness.behavior.callAgentTool('xero_read_bank_rec_capture', { tenantId: TENANT, captureId: first.capture.id, page: 1, pageSize: 1 });
    const data = JSON.parse(read.content[0].text); assert.equal(data.lines.length, 1); assert.equal(data.nextPage, 2); assert.equal(data.coverage.complete, false);
    const secondPage = JSON.parse((await w.host.harness.behavior.callAgentTool('xero_read_bank_rec_capture', { tenantId: TENANT, captureId: first.capture.id, page: 2, pageSize: 1 })).content[0].text);
    assert.equal(secondPage.lines[0].position, 2); assert.equal(secondPage.lines[0].spent, data.lines[0].spent);
    for (const invalid of [capture({ account: { ...one.account, AccountID: TENANT }, url: `https://go.xero.com/BankRec/BankRec.aspx?accountId=${TENANT}` }), capture({ account: { ...one.account, CurrencyCode: 'USD' } })]) {
      const result = await w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify(invalid) }); assert.equal(result.ok, false);
    }
    assert.equal((await w.rpc('bankRecList', { tenantId: TENANT })).total, 2);
    const filtered = JSON.parse((await w.host.harness.behavior.callAgentTool('xero_list_bank_rec_captures', { tenantId: TENANT, accountId: ACCOUNT.toUpperCase() })).content[0].text); assert.equal(filtered.total, 2);
    const root = await mkdtemp(join(tmpdir(), 'xero-bank-rec-tool-'));
    try {
      const filePath = join(root, 'capture.json'); await writeFile(filePath, json);
      const result = JSON.parse((await w.host.harness.behavior.callAgentTool('xero_import_bank_rec_capture', { tenantId: TENANT, filePath })).content[0].text); assert.equal(result.outcome, 'already_imported'); assert.equal(result.capture.id, first.capture.id);
      const wrongTenant = await w.host.harness.behavior.callAgentTool('xero_import_bank_rec_capture', { tenantId: ACCOUNT, filePath: '/SECRET_MISSING_CAPTURE.json' }); assert.equal(wrongTenant.isError, true); assert.doesNotMatch(JSON.stringify(wrongTenant), /SECRET_MISSING_CAPTURE|Could not read/);
    } finally { await rm(root, { recursive: true, force: true }); }
    assert.equal(w.calls.some(c => c.method !== 'GET'), false, 'capture operations never write to Xero');
    assert.doesNotMatch(JSON.stringify(w.host.harness.inspection.logEntries), /SECRET|Example Vendor|CARD-123|44aaaa44/);
    await w.rpc('bankRecRemove', { tenantId: TENANT, captureId: first.capture.id }); assert.equal((await w.rpc('bankRecList', { tenantId: TENANT })).total, 1);
    assert.equal((await w.rpc('bankRecList', { tenantId: TENANT })).captures[0].id, older.capture.id);
  } finally { await w.close(); }
});
test('damaged stored capture fails at the local storage boundary without leaking content or clearing evidence', async () => {
  const w = await recWorld();
  try {
    const saved = await w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify(capture()) });
    w.host.bb.storage.database().prepare('UPDATE xero_bank_rec_captures SET value=? WHERE id=?').run('SECRET_PRIVATE_CORRUPTED_JSON', saved.capture.id);
    const result = await w.host.harness.behavior.callAgentTool('xero_read_bank_rec_capture', { tenantId: TENANT, captureId: saved.capture.id }); assert.equal(result.isError, true);
    assert.match(JSON.stringify(w.host.harness.inspection.logEntries), /Xero bank_rec_store storage/); assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(w.host.harness.inspection.logEntries), /SECRET|CORRUPTED_JSON/);
    assert.equal((await w.rpc('bankRecList', { tenantId: TENANT })).total, 1);
  } finally { await w.close(); }
});

test('installer and base-currency account verification use harmless reads, and provider failure is not empty success', async () => {
  const w = await recWorld();
  try {
    w.mode('base'); const result = await w.rpc('bankRecInstaller', { tenantId: TENANT }); assert.equal(result.ok, true); assert.doesNotMatch(result.html, /SECRET/);
    assert.equal(result.accountCount, 1); assert.ok(w.calls.some(c => c.url.includes('/Organisation')));
    w.mode('failure'); const failed = await w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify(capture()) }); assert.equal(failed.ok, false);
    assert.match(JSON.stringify(w.host.harness.inspection.logEntries), /Xero accounting_read transport/); assert.doesNotMatch(failed.error + JSON.stringify(w.host.harness.inspection.logEntries), /SECRET|PRIVATE_CONTENT/);
    w.mode('ok'); assert.equal((await w.rpc('bankRecList', { tenantId: TENANT })).total, 0);
  } finally { await w.close(); }
});
test('history listing has real continuation beyond twenty captures; disconnect retains evidence but blocks stale access', async () => {
  const w = await recWorld();
  try {
    for (let i = 0; i < 22; i++) assert.equal((await w.rpc('bankRecImport', { tenantId: TENANT, json: JSON.stringify(capture({ capturedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString() })) })).ok, true);
    const first = await w.rpc('bankRecList', { tenantId: TENANT, page: 1 }), second = await w.rpc('bankRecList', { tenantId: TENANT, page: 2 });
    assert.equal(first.captures.length, 20); assert.equal(first.nextPage, 2); assert.equal(second.captures.length, 2); assert.equal(second.nextPage, null);
    assert.equal(new Set([...first.captures, ...second.captures].map(c => c.id)).size, 22);
    await w.rpc('disconnect'); assert.equal((await w.rpc('bankRecList', { tenantId: TENANT })).ok, false);
    assert.equal(w.host.bb.storage.database().prepare('SELECT COUNT(*) AS n FROM xero_bank_rec_captures').get().n, 22);
  } finally { await w.close(); }
});
