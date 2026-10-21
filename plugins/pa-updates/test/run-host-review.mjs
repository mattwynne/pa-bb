// Real disposable BB, original app bundle, synthetic typed RPC states. This
// rendered gate never installs runtime updates or touches an existing server.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { record } from './fixtures.ts';
import { localDecision } from '../core/decision.ts';
import { approvedViews, approvedState, approvedJob, assertApproved } from './approved-views.mjs';
const exec = promisify(execFile);
const plugin = resolve(fileURLToPath(new URL('../', import.meta.url))), repo = resolve(plugin, '../..');
const bb = resolve(process.env.BB_REVIEW_PACKAGE ?? join(plugin, 'node_modules/bb-app'));
const bbVersion = JSON.parse(await readFile(join(bb, 'package.json'), 'utf8')).version;
const port = Number(process.env.BB_REVIEW_PORT ?? 43910);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65535);
for (const candidate of [port, port + 1]) await new Promise((resolve, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(candidate, '127.0.0.1', () => probe.close(resolve)); });
const root = await mkdtemp(join(tmpdir(), 'pa-updates-bb-')), artifacts = await mkdtemp(join(tmpdir(), 'pa-updates-evidence-'));
let browser, server, completed = false;
const stop = () => { if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); };
const interrupted = () => { stop(); process.exitCode = 130; };
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
try {
  await mkdir(join(root, 'home')); const fixture = join(root, 'fixture');
  await cp(plugin, fixture, { recursive: true, filter: path => !['node_modules', 'dist', 'test', 'features'].some(part => path.slice(plugin.length).split('/').includes(part)) });
  await symlink(join(plugin, 'node_modules'), join(fixture, 'node_modules'));
  await writeFile(join(fixture, 'implementation.ts'), await readFile(join(plugin, 'server.ts')));
  await writeFile(join(fixture, 'server.ts'), `import plugin from './implementation.ts';
import { z } from 'zod'; import { defineRpcContract } from '@get-bb/plugin-sdk';
export default async bb=>{
await plugin(bb,{feed:async()=>null,inventory:async()=>({installed:null,runtime:null})},{inspect:async()=>[],validateMix:async()=>{},update:async()=>{throw new Error('Rendered fixture cannot activate updates');},quiesce:async()=>{},restore:async()=>{},load:()=>bb.storage.kv.get('rendered-job'),save:value=>bb.storage.kv.set('rendered-job',value),diagnose:()=>{}});
bb.rpc.register(defineRpcContract({fixtureNotify:{input:z.null(),output:z.null()}}),{fixtureNotify:async()=>{await bb.realtime.publish('application',null);return null;}});
};`);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), NODE_ENV: 'production', BB_APP_VERSION: bbVersion, BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_HOST_DAEMON_PORT: String(port + 1) };
  const output = openSync(join(root, 'server.log'), 'w', 0o600); server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', output, output] }); closeSync(output);
  const cli = async (...args) => { try { return (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout; } catch { throw new Error('gate_command_failed'); } };
  let ready = false;
  for (let n = 0; n < 150; n++) { assert.equal(server.exitCode, null, 'Isolated BB exited'); try { ready = (await fetch(env.BB_SERVER_URL)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready); assert.equal((await cli('--version')).trim(), bbVersion);
  // A comparable real integration is present, but no accounts are configured.
  for (const source of [join(repo, 'plugins/google-calendar'), fixture]) {
    const installed = JSON.parse(await cli('plugin', 'install', source, '--yes', '--json'));
    assert.equal(installed.plugin.status, 'running', installed.plugin.id);
  }
  const readRpc = async method => { const response = await fetch(env.BB_SERVER_URL + '/api/v1/plugins/pa-updates/rpc/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' }); const body = await response.json(); assert.equal(body.ok, true); return body.result; };
  let discovery;
  for (let n = 0; n < 100; n++) { discovery = await readRpc('status'); if (discovery.lastAttempt && !discovery.checking) break; await new Promise(r => setTimeout(r, 100)); }
  const live = await readRpc('applicationStatus'); assert.equal(live.failure, null); assert.equal(live.job, null);
  const release = record('0.1.1', 'a'.repeat(40)); release.plugins[0].notes = 'Synthetic release evidence.\n<script>inert text, not markup</script>\n' + 'Readable notes. '.repeat(30);
  discovery = { ...discovery, checking: false, stale: false, comparison: 'available', observation: { ...discovery.observation, release } };
  const reviewId = '11111111-1111-4111-8111-111111111111';
  const base = { checking: false, applying: false, failure: null, job: null, offers: { available: true, checkedAt: new Date().toISOString() }, review: { id: reviewId, at: new Date().toISOString(), rows: [
    { id: 'google-calendar', installed: '0.1.0', available: '0.1.1', local: 'stock', fingerprint: 'calendar', prerequisite: null },
    { id: 'fastmail', installed: '0.1.0', available: '0.1.1', local: 'custom', fingerprint: 'fastmail', prerequisite: null },
  ], runtime: { target: { id: 'synthetic-primary-host', name: 'PA test server' }, runningThreadCount: 0, rows: ['pi', 'codex', 'bb'].map(id => ({ id, installed: '1.0.0', available: '1.0.1', source: id === 'bb' ? 'npm' : 'npmGlobal', state: 'ready', reason: null, fingerprint: id })) } } };
  const job = () => ({ id: '22222222-2222-4222-8222-222222222222', reviewId, phase: 'complete', receipts: base.review.rows.map(row => ({ id: row.id, choice: row.local === 'custom' ? 'keep' : 'install', before: row.installed, preview: row.available, actual: row.local === 'custom' ? row.installed : '0.1.2', outcome: row.local === 'custom' ? 'kept' : 'updated' })), syncReserved: false, failure: null, runtimeReceipts: base.review.runtime.rows.map(row => ({ id: row.id, before: row.installed, preview: row.available, actual: '1.0.2', source: row.source, outcome: 'updated' })), bbIntent: null, confirmInterruptingThreads: false });
  browser = await chromium.launch({ headless: true, ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : { channel: 'chrome' }) });
  const views = [...approvedViews, 'first', 'checking', 'progress', 'progress_development', 'progress_saved', 'current', 'integrations_current', 'integrations_mixed', 'integrations_status', 'integrations_development', 'integrations_development_unknown', 'integrations_development_mixed', 'integrations_failed', 'integrations_rpc_failed', 'integrations_action_failed', 'normal', 'runtime_prerequisites', 'available', 'unknown', 'prerequisites', 'failed', 'consent', 'updating', 'preflight', 'cli_failed', 'restarting', 'complete', 'later_plugin', 'later_runtime', 'later_uncertain', 'bb_failed', 'interrupted', 'rpc_error', 'storage'].filter(view => !process.env.BB_REVIEW_VIEWS || process.env.BB_REVIEW_VIEWS.split(',').includes(view));
  let screenshots = 0;
  for (const view of views) for (const width of [1280, 390]) {
    console.log(`Rendering synthetic ${view} at ${width}`);
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    let state = structuredClone(base), notes = structuredClone(discovery); const writes = [];
    const laterOffer = view.startsWith('later_'), inventoryView = view.startsWith('integrations_'), approvedView = approvedViews.includes(view);
    const progressView = ['progress', 'progress_development', 'approved_checking'].includes(view), developmentView = view.startsWith('integrations_development');
    const failureMode = view === 'integrations_failed' ? 'server' : view === 'integrations_rpc_failed' ? 'read' : view === 'integrations_action_failed' ? 'action' : null;
    if (inventoryView || progressView) {
      const mixed = view === 'integrations_mixed' || view === 'integrations_development_mixed' || progressView;
      state.review.inventory = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian', 'pa-updates'].map(id => ({ id, installed: '0.1.0', state: mixed && ['google-calendar', 'fastmail'].includes(id) ? 'offered' : 'current', local: mixed && id === 'fastmail' ? 'custom' : 'stock', prerequisite: null }));
      if (!mixed) state.review.rows = [];
      state.offers.available = mixed; state.review.runtime.rows.forEach(row => { row.state = 'current'; row.available = null; });
      if (developmentView) for (const row of state.review.inventory) row.development = view === 'integrations_development_unknown' || view === 'integrations_development_mixed' && row.id === 'fastmail' ? 'unknown' : ['icloud', 'obsidian'].includes(row.id) || view === 'integrations_development_mixed' && row.id === 'google-calendar' ? 'unpublished' : 'clean';
      if (view === 'integrations_status') {
        Object.assign(state.review.inventory[1], { local: 'custom' });
        Object.assign(state.review.inventory[2], { state: 'unavailable', prerequisite: 'unavailable' });
        Object.assign(state.review.inventory[3], { state: 'pinned', local: 'unknown' });
        Object.assign(state.review.inventory[4], { state: 'unavailable', local: 'unknown', prerequisite: 'baseline_unknown' });
      }
    }
    const freshProgress = requested => ({ id: '44444444-4444-4444-8444-444444444444', requested, integrations: [], integrationsDone: false, runtime: [], runtimeDone: false, target: null });
    if (view === 'progress_saved') { state.job = job(); state.checking = true; state.progress = freshProgress(false); }
    if (view === 'first') { state.review = null; state.offers = null; notes.comparison = 'first'; }
    if (view === 'checking') state.checking = true;
    if (view === 'current') { state.offers.available = false; state.review.rows = []; state.review.runtime.rows.forEach(row => { row.state = 'current'; row.available = null; }); notes.comparison = 'current'; }
    if (view === 'unknown') { state.review.rows[0].local = 'unknown'; state.review.rows[0].prerequisite = 'baseline_unknown'; state.review.runtime.target = null; state.review.runtime.rows.forEach(row => { row.state = 'unavailable'; row.reason = 'unavailable'; }); }
    if (view === 'prerequisites') state.review.rows = ['incompatible', 'unavailable', 'baseline_unknown'].map((prerequisite, index) => ({ ...base.review.rows[0], id: ['google-calendar', 'fastmail', 'google-drive'][index], local: 'unknown', prerequisite }));
    if (view === 'failed') { state.failure = 'unavailable'; notes.stale = true; }
    if (view === 'normal') { state.review.rows = []; Object.assign(state.review.runtime.rows[1], { state: 'current', available: null }); }
    if (view === 'runtime_prerequisites') state.review.runtime.rows.forEach((row, index) => Object.assign(row, { state: 'unavailable', available: null, installed: index === 0 ? null : row.installed, source: ['missing', 'external', 'unknown'][index], reason: ['not_installed', 'unsupported_install', 'unavailable'][index] }));
    if (view === 'consent') state.review.runtime.runningThreadCount = 2;
    if (laterOffer || ['updating', 'preflight', 'cli_failed', 'restarting', 'complete', 'bb_failed', 'interrupted'].includes(view)) { state.job = job(); state.offers = laterOffer ? structuredClone(base.offers) : null; }
    if (view === 'later_uncertain') { state.job.phase = 'attention'; state.job.failure = 'interrupted'; state.job.receipts[0].outcome = 'uncertain'; state.job.receipts[0].actual = null; }
    if (view === 'updating' || view === 'preflight') {
      state.job.receipts.concat(state.job.runtimeReceipts).forEach(row => { row.outcome = 'pending'; row.actual = null; });
      if (view === 'updating') { state.applying = true; state.job.phase = 'applying'; state.job.receipts[0].outcome = 'activating'; }
      else { state.job.phase = 'attention'; state.job.failure = 'changed'; }
    }
    if (view === 'cli_failed') { state.job.phase = 'attention'; state.job.failure = 'unavailable'; state.job.runtimeReceipts[1].outcome = 'uncertain'; state.job.runtimeReceipts[1].actual = null; state.job.runtimeReceipts[2].outcome = 'pending'; state.job.runtimeReceipts[2].actual = null; }
    if (view === 'complete') {
      state.review.rows.push({ ...base.review.rows[0], id: 'google-drive', local: 'unknown', prerequisite: 'incompatible' });
      state.job.receipts.push({ id: 'google-drive', choice: 'keep', before: '0.1.0', preview: '0.1.1', actual: '0.1.0', outcome: 'skipped' });
    }
    if (view === 'restarting') { state.applying = true; state.job.phase = 'restarting'; state.job.runtimeReceipts[2].outcome = 'activating'; state.job.runtimeReceipts[2].actual = null; state.job.bbIntent = { hostId: 'synthetic-primary-host', previousResultId: null, requestedAt: new Date().toISOString(), fromVersion: '1.0.0', fromCommit: null }; }
    if (view === 'bb_failed') { state.job.phase = 'attention'; state.job.failure = 'unavailable'; state.job.runtimeReceipts[2].outcome = 'failed'; state.job.runtimeReceipts[2].actual = '1.0.0'; }
    if (view === 'interrupted') { state.offers = structuredClone(base.offers); state.job.phase = 'attention'; state.job.failure = 'interrupted'; state.job.syncReserved = true; state.job.receipts[0].outcome = 'uncertain'; state.job.receipts[0].actual = null; }
    if (view === 'storage') state.failure = 'storage';
    if (approvedView && !progressView) state = approvedState(view, base);
    if (state.review) state.review.rows = state.review.rows.map(row => { const facts = { ...row, development: row.development ?? state.review.inventory?.find(item => item.id === row.id)?.development }; return { ...facts, decision: localDecision(facts) }; });
    let releaseCheck; const checkGate = new Promise(resolve => { releaseCheck = resolve; });
    let releaseProgress; const progressGate = new Promise(resolve => { releaseProgress = resolve; });
    let releaseResponse; const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    await page.route('**/api/v1/plugins/pa-updates/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1); assert.ok(['applicationStatus', 'status', 'review', 'apply', 'resumeSync'].includes(method));
      if (['review', 'apply', 'resumeSync'].includes(method)) {
        writes.push({ method, input: route.request().postDataJSON() });
        if (method === 'review' && failureMode && writes.filter(entry => entry.method === 'review').length === 1) await checkGate;
        if (method === 'review' && failureMode === 'server') state.failure = 'unavailable';
        if (method === 'review' && progressView) {
          state.checking = true; state.progress = freshProgress(true); await readRpc('fixtureNotify'); await progressGate;
          state.review = { ...state.review, id: '33333333-3333-4333-8333-333333333333', rows: [structuredClone(base.review.rows[1])], inventory: structuredClone(state.progress.integrations), runtime: { target: state.progress.target, runningThreadCount: 0, rows: structuredClone(state.progress.runtime) } };
          state.checking = false; state.progress = null; await readRpc('fixtureNotify'); await responseGate;
        } else if (method === 'review' && (!failureMode || failureMode !== 'server' && writes.filter(entry => entry.method === 'review').length > 2)) {
          const savedJob = state.job; state = structuredClone(inventoryView || approvedView ? state : base);
          if (inventoryView || approvedView) state.review.id = '33333333-3333-4333-8333-333333333333';
          if (laterOffer) {
            state.job = savedJob; state.review.id = '33333333-3333-4333-8333-333333333333';
            state.review.rows = view === 'later_runtime' ? [] : [{ ...base.review.rows[0], installed: '0.1.2', available: '0.1.3' }];
            state.review.runtime.rows.forEach(row => { row.installed = '1.0.2'; row.available = view === 'later_runtime' && row.id === 'pi' ? '1.0.3' : null; row.state = row.available ? 'ready' : 'current'; });
          }
        }
        if (method === 'apply') { state.job = approvedView ? approvedJob(state, route.request().postDataJSON().choices) : job(); if (approvedView) state.offers = null; state.job.confirmInterruptingThreads = route.request().postDataJSON().confirmInterruptingThreads; }
        if (method === 'resumeSync') state.job.syncReserved = false;
      }
      const firstFailedCheck = writes.filter(entry => entry.method === 'review').length === 1;
      const rpcFailed = view === 'rpc_error' || firstFailedCheck && (failureMode === 'action' && method === 'review' || failureMode === 'read' && method === 'applicationStatus');
      return route.fulfill({ json: rpcFailed ? { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL private response' } } : { ok: true, result: method === 'status' ? notes : state } });
    });
    await page.goto(env.BB_SERVER_URL); await page.locator('button').first().waitFor({ timeout: 60000 });
    const skip = page.getByRole('button', { name: 'Skip setup', exact: true });
    if (await skip.isVisible()) await skip.click();
    await writeFile(join(artifacts, 'last-page.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: join(artifacts, 'last-page.png') });
    const trigger = page.getByRole('button', { name: 'PA updates', exact: true }), notice = page.getByRole('link', { name: 'PA update available', exact: true });
    const settingsPath = '/settings/plugins/pa-updates';
    const openFooter = async () => {
      await page.goto(env.BB_SERVER_URL);
      if (width === 390 && await page.locator('main[data-sidebar-shelf="closed"]').count()) { await page.getByRole('button', { name: /Toggle sidebar/ }).click(); await page.locator('main[data-sidebar-shelf="open"]').waitFor(); }
      await trigger.waitFor({ timeout: 60000 }); await trigger.focus(); await page.keyboard.press('Enter');
      await page.waitForURL('**' + settingsPath);
    };
    const openSettingsNav = async () => {
      await page.goto(env.BB_SERVER_URL + '/settings');
      const entry = page.getByRole('link', { name: 'PA updates', exact: true }); await entry.waitFor({ timeout: 60000 });
      assert.equal(await entry.getAttribute('href'), settingsPath);
      if (await entry.evaluate(el => !!el.closest('[inert]'))) { await page.getByRole('button', { name: /Toggle sidebar/ }).focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.querySelector('a[href="/settings/plugins/pa-updates"]')?.closest('[inert]')); }
      await entry.focus(); assert.equal(await entry.evaluate(el => document.activeElement === el), true, 'Native Settings entry must accept keyboard focus'); await page.keyboard.press('Enter');
      await page.waitForURL('**' + settingsPath);
    };
    const fromNotice = view === 'approved_updates' || view === 'approved_local_updates' || laterOffer || ['normal', 'available', 'prerequisites', 'integrations_mixed'].includes(view);
    if (fromNotice) { await notice.waitFor(); assert.equal(await notice.getAttribute('href'), settingsPath); await notice.focus(); await page.keyboard.press('Enter'); await page.waitForURL('**' + settingsPath); }
    else if (view === 'integrations_current' || view === 'approved_current') await openSettingsNav();
    else await openFooter();
    const section = page.getByRole('region', { name: 'Update PA', exact: true }); await section.waitFor();
    assert.equal(await page.getByRole('heading', { name: 'PA updates', exact: true }).count(), 1);
    assert.equal(await section.locator('header,dialog').count(), 0);
    assert.equal(await section.getByRole('button', { name: 'Close PA updates' }).count(), 0);
    assert.equal(await section.evaluate(el => getComputedStyle(el).maxHeight), 'none');
    await section.getByRole('button', { name: /Check again|Check for updates/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('.pa-updates [role="status"]')?.textContent.length > 0 || !!document.querySelector('.pa-updates .pa-update-row, .pa-updates .pa-update-version'));
    assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(!(await section.textContent()).includes('PRIVATE_SENTINEL')); assert.equal(await section.locator('script,a').count(), 0);
    assert.ok(await section.locator('[role="status"][aria-live="polite"]').count() > 0);
    if (['failed', 'storage', 'checking', 'updating', 'preflight', 'cli_failed', 'restarting', 'complete', 'bb_failed', 'interrupted', 'rpc_error'].includes(view)) assert.equal(await notice.count(), 0);
    assert.equal(await page.getByText('Development checkout (optional)', { exact: true }).count(), 0);
    assert.ok(!(await section.textContent()).includes('Unpublished local changes'));
    if (approvedView) await assertApproved({ view, section, page, writes });
    if (inventoryView) {
      if (failureMode) await page.waitForFunction(() => document.querySelectorAll('.pa-update-check').length === 9);
      await section.locator('.pa-updates-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await section.getByRole('button', { name: 'Check again', exact: true }).focus(); await page.keyboard.press('Enter');
      if (failureMode) {
        await page.waitForFunction(() => [...document.querySelectorAll('.pa-update-version')].filter(el => el.textContent.includes('Checking…')).length === 9);
        assert.equal(await section.locator('.pa-update-check').count(), 0); releaseCheck();
      }
      await page.waitForFunction(() => !document.querySelector('.pa-updates footer button')?.disabled && document.querySelector('.pa-updates-body')?.scrollTop === 0);
      if (view === 'integrations_current') {
        for (const name of ['Calendar', 'Fastmail', 'Google Drive', 'iCloud', 'Obsidian']) {
          const label = section.getByText(name, { exact: true }); await label.scrollIntoViewIfNeeded();
          assert.ok(await label.evaluate(el => { const row = el.getBoundingClientRect(), body = el.closest('.pa-updates-body').getBoundingClientRect(); return row.top >= body.top && row.bottom <= body.bottom; }), 'Every integration is reachable in the native scroll area');
        }
        await section.locator('.pa-updates-body').evaluate(el => { el.scrollTop = 0; });
      }
      for (const name of ['Calendar', 'Fastmail', 'Google Drive', 'iCloud', 'Obsidian']) assert.equal(await section.getByText(name, { exact: true }).count(), 1);
      const mixed = view === 'integrations_mixed' || view === 'integrations_development_mixed';
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), view === 'integrations_mixed' ? 1 : 0);
      if (!mixed) assert.equal(await notice.count(), 0);
      const expectedChecks = failureMode ? 0 : view === 'integrations_development' ? 7 : view === 'integrations_development_unknown' ? 3 : view === 'integrations_development_mixed' ? 5 : view === 'integrations_current' ? 9 : mixed ? 7 : 5;
      assert.equal(await section.locator('.pa-update-check').count(), expectedChecks);
      assert.equal(await section.locator('.pa-update-card').filter({ hasText: 'Up to date' }).count(), expectedChecks);
      for (const icon of await section.locator('.pa-update-check').all()) {
        assert.equal(await icon.getAttribute('aria-hidden'), 'true');
        assert.notEqual(await icon.evaluate(el => getComputedStyle(el).color), await icon.evaluate(el => getComputedStyle(el.parentElement).color));
      }
      if (mixed) for (const name of ['Calendar', 'Fastmail']) assert.equal(await section.locator('.pa-update-card,.pa-update-row').filter({ has: page.getByText(name, { exact: true }) }).locator('.pa-update-check').count(), 0);
      if (failureMode) assert.equal(await section.getByText('Couldn’t check', { exact: false }).count(), 9);
      if (developmentView) {
        assert.equal(await section.locator('.pa-development-badge').count(), view === 'integrations_development_unknown' ? 0 : mixed ? 4 : 2);
        assert.equal(await section.locator('.pa-development-unknown').count(), view === 'integrations_development_unknown' ? 6 : 0);
        for (const name of ['iCloud', 'Obsidian']) { const card = section.locator('.pa-update-card').filter({ has: page.getByText(name, { exact: true }) }); assert.equal(await card.locator('.pa-update-check').count(), 0); assert.ok((await card.textContent()).includes('0.1.0')); assert.ok(!(await card.textContent()).includes('Up to date')); }
      }
      if (mixed) assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      if (view === 'integrations_status') for (const status of ['Local changes', 'Couldn’t check', 'Version pinned', 'Changes unverified']) await section.getByText(new RegExp(status)).waitFor();
      assert.deepEqual(writes.map(entry => entry.method), ['review']);
    }
    if (progressView) {
      const previous = structuredClone(state.review);
      await section.getByRole('button', { name: 'Check again', exact: true }).focus(); await page.keyboard.press('Enter');
      const group = section.getByRole('group', { name: 'Check progress', exact: true }); await group.waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.pa-update-spinner').length === 9);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), 0);
      assert.equal(await notice.count(), 0);
      const spinner = group.locator('.pa-update-spinner').first(); assert.equal(await spinner.getAttribute('aria-hidden'), 'true');
      assert.equal(await spinner.evaluate(el => getComputedStyle(el).animationName), 'pa-update-spin');
      await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await spinner.evaluate(el => getComputedStyle(el).animationName), 'none'); await page.emulateMedia({ reducedMotion: 'no-preference' });
      state.progress.integrations.push({ id: 'google-calendar', installed: '0.1.1', local: 'stock', state: 'current', prerequisite: null }); await readRpc('fixtureNotify');
      await group.locator('[data-check-id="google-calendar"] .pa-update-check').waitFor();
      assert.equal(await group.locator('.pa-update-spinner').count(), 8); assert.equal(await group.locator('.pa-update-check').count(), 1);
      await page.screenshot({ path: join(artifacts, `${view}-first-${width}.png`) }); screenshots++;
      state.progress.integrations.push(
        { id: 'fastmail', installed: '0.1.0', local: 'custom', state: 'offered', prerequisite: null },
        { id: 'google-drive', installed: '0.1.0', local: 'stock', state: 'unavailable', prerequisite: 'unavailable' },
        { id: 'icloud', installed: '0.1.0', local: 'stock', state: 'current', prerequisite: null },
        { id: 'obsidian', installed: '0.1.0', local: 'unknown', state: 'unavailable', prerequisite: 'baseline_unknown' },
        { id: 'pa-updates', installed: '0.2.8', local: 'stock', state: 'current', prerequisite: null });
      if (view === 'progress_development') for (const row of state.progress.integrations) if (['icloud', 'obsidian'].includes(row.id)) row.development = 'unpublished';
      state.progress.integrationsDone = true; state.progress.target = structuredClone(base.review.runtime.target);
      state.progress.runtime.push({ ...base.review.runtime.rows[0], state: 'current', available: null }, { ...base.review.runtime.rows[1], state: 'unavailable', available: null, reason: 'unavailable' }); await readRpc('fixtureNotify');
      await page.waitForFunction(count => document.querySelectorAll('.pa-update-spinner').length === 1 && document.querySelectorAll('.pa-update-check').length === count, view === 'progress_development' ? 3 : 4);
      if (view === 'progress_development') { assert.equal(await group.locator('.pa-development-badge').count(), 3); assert.equal(await group.locator('[data-check-id="icloud"] .pa-update-check').count(), 0); }
      for (const id of ['fastmail', 'google-drive', 'obsidian', 'codex']) assert.equal(await group.locator(`[data-check-id="${id}"] .pa-update-check`).count(), 0);
      assert.ok((await group.locator('[data-check-id="fastmail"]').textContent()).includes('Local changes'));
      assert.ok((await group.locator('[data-check-id="obsidian"]').textContent()).includes('Changes unverified'));
      assert.equal(await section.locator('.pa-update-toggle').count(), 0); assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), 0); assert.deepEqual(state.review, previous);
      await page.screenshot({ path: join(artifacts, `${view}-partial-${width}.png`) }); screenshots++;
      state.progress.runtime.push(structuredClone(base.review.runtime.rows[2])); state.progress.runtimeDone = true; await readRpc('fixtureNotify');
      await page.waitForFunction(() => document.querySelectorAll('.pa-update-spinner').length === 0);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), 0, 'Even all reported rows are not an authorized review until final completion');
      releaseProgress(); await group.waitFor({ state: 'hidden' });
      await page.waitForFunction(count => document.querySelectorAll('.pa-update-check').length === count && document.querySelectorAll('.pa-update-spinner').length === 0, view === 'progress_development' ? 3 : 4);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).isDisabled(), true, 'The final fresh result stays visible while the review RPC response is still pending');
      releaseResponse(); await page.waitForFunction(() => !document.querySelector('.pa-update-primary')?.disabled);
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).isEnabled(), true);
      assert.deepEqual(writes.map(entry => entry.method), ['review']);
    }
    if (view === 'progress_saved') {
      const saved = structuredClone(state.job), results = await section.locator('.pa-update-results').textContent();
      assert.equal(await section.getByRole('group', { name: 'Check progress', exact: true }).count(), 0); assert.equal(await notice.count(), 0);
      state.progress.integrations.push({ id: 'google-calendar', installed: '0.1.2', local: 'stock', state: 'current', prerequisite: null }); await readRpc('fixtureNotify');
      assert.equal(await section.locator('.pa-update-results').textContent(), results); assert.deepEqual(state.job, saved);
      state.checking = false; state.progress = null; await readRpc('fixtureNotify');
      await page.waitForFunction(() => document.querySelector('.pa-updates [role="status"]')?.textContent === 'Update finished');
    }
    if (view === 'failed') await section.getByText('Check failed — previous results may be out of date', { exact: true }).waitFor();
    if (view === 'available') {
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      await section.getByText('Keep local leaves this component unchanged. Installing a release replaces its code, not your settings or data.', { exact: true }).waitFor();
      const choose = async name => { await section.getByRole('button', { name, exact: true }).focus(); await page.keyboard.press('Enter'); };
      assert.equal(await section.getByRole('button', { name: 'Install all released', exact: true }).count(), 0, 'bulk shortcuts are only useful for several local choices');
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      await choose('Install released version');
      await choose('Keep local');
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
    }
    if (['normal', 'available'].includes(view)) {
      const text = await section.textContent();
      for (const removed of ['PA updates available', 'PA runtime', 'Pi CLI', 'Codex CLI', 'CLI receipts', 'native launcher', 'newer compatible release', 'each component’s supported', 'Installed 1.0.0']) assert.ok(!text.includes(removed), removed);
      await section.getByText(view === 'normal' ? 'BB will restart. Settings and data stay.' : 'BB will restart.', { exact: true }).waitFor();
      assert.equal(await section.locator('[role="status"]').textContent(), view === 'normal' ? 'Updates available' : '');
    }
    if (view === 'normal') {
      assert.equal(await section.getByText('Codex', { exact: true }).count(), 1);
      assert.equal(await section.getByText('1.0.0 → 1.0.1', { exact: true }).count(), 2);
      assert.equal(await section.locator('h3').count(), 0);
      assert.equal(await section.locator('.pa-update-card svg').count(), 4);
      assert.equal(await section.locator('.pa-update-card button').count(), 0);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), 1);
      for (const card of await section.locator('.pa-update-card').all()) {
        assert.equal(await card.evaluate(el => getComputedStyle(el).borderTopStyle), 'solid');
        assert.ok(await card.evaluate(el => el.getBoundingClientRect().height <= 56), 'Normal version row stays compact');
        assert.ok(await card.locator('.pa-update-version').evaluate(el => { const [label, version] = [...el.children].map(child => child.getBoundingClientRect()); return Math.abs(label.y - version.y) < 2; }), 'Name and versions share a line');
      }
    }
    if (['current', 'runtime_prerequisites'].includes(view)) for (const name of ['Pi', 'Codex', 'BB']) await section.getByText(name, { exact: true }).waitFor();
    if (view === 'runtime_prerequisites') {
      assert.equal(await section.locator('.pa-update-check').count(), 0);
      assert.ok((await section.locator('.pa-update-card').filter({ has: page.getByText('BB', { exact: true }) }).textContent()).includes('Couldn’t check'));
      await section.getByText(/This CLI is not installed/).waitFor();
      await section.getByText(/This installation cannot use/).waitFor();
      await section.getByText(/Could not finish this step/).waitFor();
    }
    if (view === 'prerequisites') {
      await section.getByText('The available release does not meet this integration’s requirements. This integration will not be replaced.', { exact: true }).waitFor();
      await section.getByText('Could not check this integration. Check BB and your connection, then check again.', { exact: true }).waitFor();
      assert.equal(await section.getByText(/The original installed build could not be verified/).count(), 1);
    }
    if (['updating', 'preflight', 'cli_failed', 'complete'].includes(view)) {
      assert.ok(!(await section.locator('.pa-update-results').textContent()).includes('Not installed'));
      assert.ok(!(await section.locator('.pa-update-results').textContent()).includes('unverified'));
      const result = section.locator('.pa-update-results li > span:last-child').filter({ hasText: view === 'updating' ? 'Waiting…' : 'Not updated' });
      assert.equal(await result.count(), view === 'updating' ? 4 : view === 'preflight' ? 5 : 1);
      await result.first().scrollIntoViewIfNeeded();
    }
    const check = section.getByRole('button', { name: /Check again|Check for updates/ });
    if (await check.isEnabled()) { await check.focus(); assert.equal(await check.evaluate(el => getComputedStyle(el).outlineStyle), 'solid'); }
    await page.getByRole('heading', { name: 'PA updates', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, 'last-open.png') });
    await page.mouse.move(width - 10, 10); await page.screenshot({ path: join(artifacts, `${view}-${width}.png`) }); screenshots++;
    if (['integrations_current', 'integrations_mixed', 'normal', 'available'].includes(view)) { await section.screenshot({ path: join(artifacts, `${view}-panel-${width}.png`) }); screenshots++; }
    if (view === 'available') {
      const detail = section.locator('summary', { hasText: 'Release notes' }); await detail.scrollIntoViewIfNeeded(); await detail.focus(); await page.keyboard.press('Enter');
      assert.equal(await detail.evaluate(el => el.parentElement.open), true); assert.equal(await section.locator('script').count(), 0);
      await page.screenshot({ path: join(artifacts, `notes-${width}.png`) }); screenshots++;
      await section.getByRole('button', { name: 'Update PA', exact: true }).click();
      assert.equal(writes[0].input.choices.find(choice => choice.id === 'fastmail').choice, 'keep'); assert.equal(writes[0].input.confirmInterruptingThreads, false);
    }
    if (laterOffer) {
      const saved = structuredClone(state.job);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), 0, 'Opening the pill does not dismiss or reapply the old result');
      assert.ok((await section.locator('.pa-update-results').textContent()).includes(view === 'later_uncertain' ? 'Result uncertain' : 'Installed 0.1.2'));
      await openFooter(); await section.waitFor();
      assert.ok((await section.locator('.pa-update-results').textContent()).includes(view === 'later_uncertain' ? 'Result uncertain' : 'Installed 0.1.2'));
      await openSettingsNav(); await section.waitFor();
      assert.ok((await section.locator('.pa-update-results').textContent()).includes(view === 'later_uncertain' ? 'Result uncertain' : 'Installed 0.1.2'));
      await page.goto(env.BB_SERVER_URL); await notice.waitFor(); await notice.focus(); await page.keyboard.press('Enter'); await section.waitFor();
      assert.equal(writes.length, 0); assert.deepEqual(state.job, saved);
      await section.getByRole('button', { name: 'Check again', exact: true }).click();
      await section.getByText(view === 'later_runtime' ? '1.0.2 → 1.0.3' : '0.1.2 → 0.1.3', { exact: true }).waitFor();
      assert.equal(writes[0].method, 'review'); assert.deepEqual(state.job, saved);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).isEnabled(), true);
      await page.screenshot({ path: join(artifacts, `${view}-new-review-${width}.png`) }); screenshots++;
    }
    if (view === 'consent') {
      const apply = section.getByRole('button', { name: 'Update PA', exact: true }); assert.equal(await apply.isDisabled(), true);
      const consent = section.getByRole('checkbox'); await consent.focus(); await page.keyboard.press('Space'); assert.equal(await apply.isEnabled(), true);
      await page.screenshot({ path: join(artifacts, `consent-checked-${width}.png`) }); screenshots++;
      await apply.click(); assert.equal(writes[0].input.confirmInterruptingThreads, true);
    }
    if (view === 'failed') { await section.getByRole('button', { name: 'Check again' }).click(); await page.waitForFunction(() => document.querySelector('.pa-updates [role="status"]')?.textContent === ''); assert.equal(writes[0].method, 'review'); }
    if (view === 'interrupted') { await section.getByRole('button', { name: 'Resume previously enabled folders' }).click(); assert.equal(writes[0].method, 'resumeSync'); }
    assert.equal(pageErrors.length, 0, 'Rendered app has JavaScript errors');
    if (failureMode === 'read' || failureMode === 'action') {
      // A successful read of the old cached review must not restore green checks.
      await check.focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.querySelector('.pa-updates footer button')?.disabled);
      assert.equal(await section.locator('.pa-update-check').count(), 0); assert.equal(await section.getByText('Couldn’t check', { exact: false }).count(), 9);
      // A genuinely new successful review can confirm the versions again.
      await check.focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelectorAll('.pa-update-check').length === 9);
    }
    if (view === 'approved_local_updates') {
      await section.getByRole('button', { name: 'Check again', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `${view}-bottom-${width}.png`) }); screenshots++;
      const cloud = section.getByRole('group', { name: 'iCloud local changes', exact: true });
      await cloud.getByRole('button', { name: 'Install released version', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.screenshot({ path: join(artifacts, `${view}-opt-in-${width}.png`) }); screenshots++;
      await section.getByRole('button', { name: 'Update PA', exact: true }).click();
      assert.deepEqual(writes.at(-1).input.choices, [{ id: 'icloud', choice: 'install' }, { id: 'obsidian', choice: 'keep' }]);
    }
    if (view === 'approved_updates') {
      const apply = section.getByRole('button', { name: 'Update PA', exact: true }); assert.equal(await apply.isDisabled(), true);
      await section.getByRole('checkbox').focus(); await page.keyboard.press('Space'); assert.equal(await apply.isEnabled(), true);
      await apply.click(); assert.equal(writes.at(-1).input.confirmInterruptingThreads, true);
    }
    if (view === 'approved_results') {
      const saved = structuredClone(state.job), beforeWrites = writes.length;
      state.offers = { available: true, checkedAt: new Date(Date.parse(state.review.at) + 1).toISOString() };
      await readRpc('fixtureNotify');
      await page.waitForFunction(() => document.querySelectorAll('.pa-update-check').length === 0);
      assert.deepEqual(state.job, saved); assert.equal(writes.length, beforeWrites);
      assert.equal(await section.getByText('Installed 0.1.2', { exact: true }).count(), 1);
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), 0);
      await page.screenshot({ path: join(artifacts, `${view}-later-offer-${width}.png`) }); screenshots++;
    }
    const savedJob = structuredClone(state.job), callsBeforeNavigation = writes.length;
    await openSettingsNav(); await section.waitFor(); await openFooter(); await section.waitFor();
    assert.deepEqual(state.job, savedJob); assert.equal(writes.length, callsBeforeNavigation, 'Navigation does not review, apply or discard a result');
    if (savedJob && savedJob.reviewId === state.review?.id) await section.locator('.pa-update-results').waitFor();
    await page.close();
  }
  await browser.close(); browser = null;
  await cli('plugin', 'disable', 'pa-updates');
  const installed = JSON.parse(await cli('plugin', 'list', '--json')).plugins;
  assert.equal(installed.find(p => p.id === 'pa-updates').status, 'disabled'); assert.equal(installed.find(p => p.id === 'google-calendar').status, 'running');
  const result = { evidence: 'Original app in disposable BB; synthetic RPC states, no native runtime writes', bb: bbVersion, views, screenshots, originalBundle: true, settingsHome: true, footerAndNoticeNavigation: true, desktopAndNarrowKeyboard: true, explicitNativeConsent: views.some(view => ['consent', 'approved_updates'].includes(view)), defaultKeep: views.some(view => ['available', 'integrations_mixed', 'progress', 'approved_local_updates'].includes(view)), liveProgressSignals: views.some(view => ['progress', 'progress_development', 'approved_checking'].includes(view)), savedResultDuringDiscovery: views.includes('progress_saved'), laterOfferReview: ['later_plugin', 'later_runtime', 'later_uncertain'].every(view => views.includes(view)), artifacts };
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2)); completed = true; console.log(JSON.stringify(result));
} finally {
  await browser?.close(); stop();
  if (server && server.exitCode === null && server.signalCode === null) { await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 10000))]); if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); }
  process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  if (completed) await rm(root, { recursive: true, force: true }); else console.error('Retained disposable host/evidence:', root, artifacts);
}
