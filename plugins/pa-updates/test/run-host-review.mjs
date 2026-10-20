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
export default bb=>plugin(bb,{feed:async()=>null,inventory:async()=>({installed:null,runtime:null})},{inspect:async()=>[],validateMix:async()=>{},update:async()=>{throw new Error('Rendered fixture cannot activate updates');},quiesce:async()=>{},restore:async()=>{},load:()=>bb.storage.kv.get('rendered-job'),save:value=>bb.storage.kv.set('rendered-job',value),diagnose:()=>{}});`);
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
  const views = ['first', 'checking', 'current', 'integrations_current', 'integrations_mixed', 'integrations_status', 'normal', 'runtime_prerequisites', 'available', 'unknown', 'prerequisites', 'failed', 'consent', 'updating', 'preflight', 'cli_failed', 'restarting', 'complete', 'later_plugin', 'later_runtime', 'later_uncertain', 'bb_failed', 'interrupted', 'rpc_error', 'storage'].filter(view => !process.env.BB_REVIEW_VIEWS || process.env.BB_REVIEW_VIEWS.split(',').includes(view));
  let screenshots = 0;
  for (const view of views) for (const width of [1280, 390]) {
    console.log(`Rendering synthetic ${view} at ${width}`);
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    let state = structuredClone(base), notes = structuredClone(discovery); const writes = [];
    const laterOffer = view.startsWith('later_'), inventoryView = view.startsWith('integrations_');
    if (inventoryView) {
      const mixed = view === 'integrations_mixed';
      state.review.inventory = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian'].map(id => ({ id, installed: '0.1.0', state: mixed && ['google-calendar', 'fastmail'].includes(id) ? 'offered' : 'current', local: mixed && id === 'fastmail' ? 'custom' : 'stock', prerequisite: null }));
      if (!mixed) state.review.rows = [];
      state.offers.available = mixed; state.review.runtime.rows.forEach(row => { row.state = 'current'; row.available = null; });
      if (view === 'integrations_status') {
        Object.assign(state.review.inventory[1], { local: 'custom' });
        Object.assign(state.review.inventory[2], { state: 'unavailable', prerequisite: 'unavailable' });
        Object.assign(state.review.inventory[3], { state: 'pinned', local: 'unknown' });
        Object.assign(state.review.inventory[4], { state: 'unavailable', local: 'unknown', prerequisite: 'baseline_unknown' });
      }
    }
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
    await page.route('**/api/v1/plugins/pa-updates/rpc/**', route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1); assert.ok(['applicationStatus', 'status', 'review', 'apply', 'resumeSync'].includes(method));
      if (['review', 'apply', 'resumeSync'].includes(method)) {
        writes.push({ method, input: route.request().postDataJSON() });
        if (method === 'review') {
          const savedJob = state.job; state = structuredClone(inventoryView ? state : base);
          if (inventoryView) state.review.id = '33333333-3333-4333-8333-333333333333';
          if (laterOffer) {
            state.job = savedJob; state.review.id = '33333333-3333-4333-8333-333333333333';
            state.review.rows = view === 'later_runtime' ? [] : [{ ...base.review.rows[0], installed: '0.1.2', available: '0.1.3' }];
            state.review.runtime.rows.forEach(row => { row.installed = '1.0.2'; row.available = view === 'later_runtime' && row.id === 'pi' ? '1.0.3' : null; row.state = row.available ? 'ready' : 'current'; });
          }
        }
        if (method === 'apply') { state.job = job(); state.job.confirmInterruptingThreads = route.request().postDataJSON().confirmInterruptingThreads; }
        if (method === 'resumeSync') state.job.syncReserved = false;
      }
      return route.fulfill({ json: view === 'rpc_error' ? { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL private response' } } : { ok: true, result: method === 'status' ? notes : state } });
    });
    await page.goto(env.BB_SERVER_URL); await page.locator('button').first().waitFor({ timeout: 60000 });
    const skip = page.getByRole('button', { name: 'Skip setup', exact: true });
    if (await skip.isVisible()) await skip.click();
    await writeFile(join(artifacts, 'last-page.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: join(artifacts, 'last-page.png') });
    const trigger = page.getByRole('button', { name: 'PA updates', exact: true }), notice = page.getByRole('button', { name: 'PA update available', exact: true });
    const fromNotice = laterOffer || ['normal', 'available', 'prerequisites', 'integrations_mixed'].includes(view);
    if (fromNotice) { await notice.waitFor(); await notice.focus(); await page.keyboard.press('Enter'); }
    else {
      if (width === 390 && await page.locator('main[data-sidebar-shelf="closed"]').count()) { await page.getByRole('button', { name: /Toggle sidebar/ }).click(); await page.locator('main[data-sidebar-shelf="open"]').waitFor(); }
      await trigger.waitFor({ timeout: 60000 }); await trigger.focus(); await page.keyboard.press('Enter');
    }
    const section = page.getByRole('region', { name: 'Update PA', exact: true }); await section.waitFor();
    await section.getByRole('button', { name: /Check again|Check for updates/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('.pa-updates [role="status"]')?.textContent.length > 0 || !!document.querySelector('.pa-updates .pa-update-row, .pa-updates .pa-update-version'));
    assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(!(await section.textContent()).includes('PRIVATE_SENTINEL')); assert.equal(await section.locator('script,a').count(), 0);
    assert.ok(await section.locator('[role="status"][aria-live="polite"]').count() > 0);
    await page.waitForFunction(() => { const el = document.querySelector('.pa-updates'); const host = el.closest('dialog,[id^="plugin-sidebar-footer-disclosure-"]').getBoundingClientRect(); const own = el.getBoundingClientRect(); const check = el.querySelector('footer button').getBoundingClientRect(); return own.bottom <= host.bottom + 1 && check.bottom <= host.bottom && check.top >= host.top; });
    if (['failed', 'storage', 'checking', 'updating', 'preflight', 'cli_failed', 'restarting', 'complete', 'bb_failed', 'interrupted', 'rpc_error'].includes(view)) assert.equal(await notice.count(), 0);
    if (inventoryView) {
      await section.locator('.pa-updates-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await section.getByRole('button', { name: 'Check again', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.pa-updates footer button')?.disabled && document.querySelector('.pa-updates-body')?.scrollTop === 0);
      if (view === 'integrations_current') {
        for (const name of ['Calendar', 'Fastmail', 'Google Drive', 'iCloud', 'Obsidian']) {
          const label = section.getByText(name, { exact: true }); await label.scrollIntoViewIfNeeded();
          assert.ok(await label.evaluate(el => { const row = el.getBoundingClientRect(), body = el.closest('.pa-updates-body').getBoundingClientRect(); return row.top >= body.top && row.bottom <= body.bottom; }), 'Every integration is reachable in the native scroll area');
        }
        await section.screenshot({ path: join(artifacts, `${view}-components-${width}.png`) }); screenshots++;
        await section.locator('.pa-updates-body').evaluate(el => { el.scrollTop = 0; });
      }
      for (const name of ['Calendar', 'Fastmail', 'Google Drive', 'iCloud', 'Obsidian']) assert.equal(await section.getByText(name, { exact: true }).count(), 1);
      const mixed = view === 'integrations_mixed';
      assert.equal(await section.getByRole('button', { name: 'Update PA', exact: true }).count(), mixed ? 1 : 0);
      if (!mixed) assert.equal(await notice.count(), 0);
      assert.equal(await section.locator('.pa-update-card').filter({ hasText: 'Up to date' }).count(), view === 'integrations_current' ? 5 : mixed ? 3 : 1);
      if (mixed) assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      if (view === 'integrations_status') for (const status of ['Local changes', 'Could not check', 'Version pinned', 'Changes unverified']) await section.getByText(new RegExp(status)).waitFor();
      assert.deepEqual(writes.map(entry => entry.method), ['review']);
    }
    if (view === 'failed') await section.getByText('Check failed — previous results may be out of date', { exact: true }).waitFor();
    if (view === 'available') {
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      await section.getByText('Installing a release replaces local changes, not settings or data.', { exact: true }).waitFor();
      const choose = async name => { await section.getByRole('button', { name, exact: true }).focus(); await page.keyboard.press('Enter'); };
      await choose('Install all released');
      assert.equal(await section.getByRole('button', { name: 'Install released version', exact: true }).getAttribute('aria-pressed'), 'true');
      await choose('Keep all local');
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
      await choose('Install released version');
      await choose('Keep local');
      assert.equal(await section.getByRole('button', { name: 'Keep local', exact: true }).getAttribute('aria-pressed'), 'true');
    }
    if (['normal', 'available'].includes(view)) {
      const text = await section.textContent();
      for (const removed of ['PA updates available', 'PA runtime', 'Pi CLI', 'Codex CLI', 'CLI receipts', 'native launcher', 'newer compatible release', 'each component’s supported', 'Installed 1.0.0']) assert.ok(!text.includes(removed), removed);
      await section.getByText('BB will restart. Settings and data stay.', { exact: true }).waitFor();
      assert.equal(await section.locator('[role="status"]').textContent(), '');
    }
    if (view === 'normal') {
      assert.equal(await section.getByText('Codex', { exact: true }).count(), 0);
      assert.equal(await section.getByText('1.0.0 → 1.0.1', { exact: true }).count(), 2);
      assert.equal(await section.locator('h3').count(), 0);
      assert.equal(await section.locator('.pa-update-card svg').count(), 2);
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
      const result = section.getByText(view === 'updating' ? 'Waiting…' : 'Not updated', { exact: true });
      assert.equal(await result.count(), view === 'updating' ? 4 : view === 'preflight' ? 5 : 1);
      await result.first().scrollIntoViewIfNeeded();
    }
    const close = section.getByRole('button', { name: 'Close PA updates' }); await close.focus();
    await page.screenshot({ path: join(artifacts, 'last-open.png') });
    await writeFile(join(artifacts, 'last-focus.json'), JSON.stringify(await close.evaluate(el => ({ focused: document.activeElement === el, outline: getComputedStyle(el).outlineStyle, active: document.activeElement.outerHTML, sidebar: document.querySelector('main')?.getAttribute('data-sidebar-shelf'), inert: !!el.closest('[inert]') })), null, 2));
    assert.equal(await close.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await page.mouse.move(width - 10, 10); await page.screenshot({ path: join(artifacts, `${view}-${width}.png`) }); screenshots++;
    if (inventoryView || ['normal', 'available'].includes(view)) { await section.screenshot({ path: join(artifacts, `${view}-panel-${width}.png`) }); screenshots++; }
    if (inventoryView) { await section.locator('.pa-updates-body').evaluate(el => { el.scrollTop = el.scrollHeight; }); await section.screenshot({ path: join(artifacts, `${view}-bottom-${width}.png`) }); screenshots++; }
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
      await close.click(); await section.waitFor({ state: 'hidden' });
      if (width === 390 && await page.locator('main[data-sidebar-shelf="closed"]').count()) { await page.getByRole('button', { name: /Toggle sidebar/ }).click(); await page.locator('main[data-sidebar-shelf="open"]').waitFor(); }
      await trigger.focus(); await page.keyboard.press('Enter'); await section.waitFor();
      assert.ok((await section.locator('.pa-update-results').textContent()).includes(view === 'later_uncertain' ? 'Result uncertain' : 'Installed 0.1.2'));
      await section.getByRole('button', { name: 'Close PA updates' }).click(); await section.waitFor({ state: 'hidden' });
      await notice.focus(); await page.keyboard.press('Enter'); await section.waitFor();
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
    await section.getByRole('button', { name: 'Close PA updates' }).focus(); await page.keyboard.press('Escape'); await section.waitFor({ state: 'hidden' });
    assert.equal(await (fromNotice ? notice : trigger).evaluate(el => document.activeElement === el), true, 'Closing restores focus to the entry button');
    await page.close();
  }
  await browser.close(); browser = null;
  await cli('plugin', 'disable', 'pa-updates');
  const installed = JSON.parse(await cli('plugin', 'list', '--json')).plugins;
  assert.equal(installed.find(p => p.id === 'pa-updates').status, 'disabled'); assert.equal(installed.find(p => p.id === 'google-calendar').status, 'running');
  const result = { evidence: 'Original app in disposable BB; synthetic RPC states, no native runtime writes', bb: bbVersion, views, screenshots, originalBundle: true, desktopAndNarrowKeyboard: true, explicitNativeConsent: views.includes('consent'), defaultKeep: views.includes('available'), laterOfferReview: ['later_plugin', 'later_runtime', 'later_uncertain'].every(view => views.includes(view)), artifacts };
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2)); completed = true; console.log(JSON.stringify(result));
} finally {
  await browser?.close(); stop();
  if (server && server.exitCode === null && server.signalCode === null) { await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 10000))]); if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); }
  process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  if (completed) await rm(root, { recursive: true, force: true }); else console.error('Retained disposable host/evidence:', root, artifacts);
}
