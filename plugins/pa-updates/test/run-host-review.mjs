// Disposable BB 0.45.0. All checkouts, releases and older installations are
// generated synthetic evidence; never points installers at an existing server.
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
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
const plugin = resolve(fileURLToPath(new URL('../', import.meta.url)));
const repo = resolve(plugin, '../..');
const bb = join(plugin, 'node_modules/bb-app');
const port = Number(process.env.BB_REVIEW_PORT ?? 43910);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65535);
for (const candidate of [port, port + 1]) await new Promise((resolve, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(candidate, '127.0.0.1', () => probe.close(resolve)); });
const root = await mkdtemp(join(tmpdir(), 'pa-updates-bb-'));
const artifacts = await mkdtemp(join(tmpdir(), 'pa-updates-evidence-'));
await mkdir(join(root, 'home')); await mkdir(join(root, 'checkout')); await mkdir(join(root, 'fixture'));
const checkout = join(root, 'checkout'); const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
await mkdir(join(checkout, 'plugins/google-calendar'), { recursive: true });
const source = join(checkout, 'plugins/google-calendar/server.ts'); await writeFile(source, 'synthetic baseline\n'); git('add', '.'); git('commit', '-qm', 'baseline'); const baseline = git('rev-parse', 'HEAD');
const feedFile = join(root, 'release.json'); const clockFile = join(root, 'clock'); const countFile = join(root, 'calls');
let clock = Date.parse('2026-10-19T12:00:00Z');
await writeFile(clockFile, String(clock)); await writeFile(countFile, ''); await writeFile(feedFile, JSON.stringify(record('0.1.1', baseline)));
await cp(plugin, join(root, 'fixture'), { recursive: true, filter: path => !['node_modules', 'dist', 'test', 'features'].some(part => path.slice(plugin.length).split('/').includes(part)) });
await symlink(join(plugin, 'node_modules'), join(root, 'fixture/node_modules'));
await writeFile(join(root, 'fixture/implementation.ts'), await readFile(join(plugin, 'server.ts')));
await writeFile(join(root, 'fixture/server.ts'), `import plugin from './implementation.ts';\nimport {readFileSync,appendFileSync} from 'node:fs';\nexport default bb => plugin(bb, { now:()=>Number(readFileSync(${JSON.stringify(clockFile)},'utf8')), feed:async signal=>{if(signal.aborted)throw new Error('cancelled');appendFileSync(${JSON.stringify(countFile)},'check\\n');const text=readFileSync(${JSON.stringify(feedFile)},'utf8');if(text==='fail')throw new Error('PRIVATE_SENTINEL token account /private');return {text,identity:JSON.parse(text).identity};} });`);
// Generated older Calendar installation, not a change to the pilot source.
const older = join(root, 'older-calendar');
await cp(join(repo, 'plugins/google-calendar'), older, { recursive: true, filter: path => !['node_modules', 'dist'].some(part => path.split('/').includes(part)) });
const oldPackage = JSON.parse(await readFile(join(older, 'package.json'), 'utf8')); oldPackage.version = '0.1.0'; await writeFile(join(older, 'package.json'), JSON.stringify(oldPackage));
await symlink(join(repo, 'plugins/google-calendar/node_modules'), join(older, 'node_modules'));
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_HOST_DAEMON_PORT: String(port + 1), PA_UPDATES_CALENDAR_CHECKOUT: checkout };
const output = openSync(join(root, 'server.log'), 'w', 0o600); const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', output, output] }); closeSync(output);
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout;
let browser; let completed = false;
try {
  let ready = false;
  for (let n = 0; n < 150; n++) { assert.equal(server.exitCode, null, 'Isolated BB exited'); try { ready = (await fetch(env.BB_SERVER_URL)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready); assert.equal((await cli('--version')).trim(), '0.45.0');
  for (const path of [older, join(root, 'fixture')]) { const installed = JSON.parse(await cli('plugin', 'install', path, '--yes', '--json')); assert.equal(installed.plugin.status, 'running', JSON.stringify({ id: installed.plugin.id, detail: installed.plugin.statusDetail })); }
  const installed = JSON.parse(await cli('plugin', 'list', '--json')).plugins;
  assert.equal(installed.find(p => p.id === 'google-calendar').version, '0.1.0');
  const rpc = async (method, input = null) => { const response = await fetch(env.BB_SERVER_URL + '/api/v1/plugins/pa-updates/rpc/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body.result; };
  let initial;
  for (let n = 0; n < 100; n++) { initial = await rpc('status'); if (initial.observation && !initial.checking) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(initial.observation.local.outcome, 'clean'); assert.equal(initial.observation.installed.version, '0.1.0');
  const index = await readFile(join(checkout, '.git/index'));
  await writeFile(source, 'PRIVATE_SENTINEL dirty local work\n'); clock += 60001; await writeFile(clockFile, String(clock));
  const beforeCalls = (await readFile(countFile, 'utf8')).split('\n').filter(Boolean).length;
  const joined = await Promise.all(Array.from({ length: 8 }, () => rpc('check')));
  assert.ok(joined.every(status => status.observation.local.outcome === 'local_changes'));
  assert.equal((await readFile(countFile, 'utf8')).split('\n').filter(Boolean).length, beforeCalls + 1);
  assert.equal(await readFile(source, 'utf8'), 'PRIVATE_SENTINEL dirty local work\n'); assert.deepEqual(await readFile(join(checkout, '.git/index')), index);
  // All mutations below create fixture history; the checker only observes it.
  git('commit', '-qam', 'local work'); const local = git('rev-parse', 'HEAD'); git('checkout', '-qb', 'candidate', baseline); await writeFile(source, 'release work\n'); git('commit', '-qam', 'candidate'); const candidate = git('rev-parse', 'HEAD'); git('checkout', '-q', local);
  await writeFile(feedFile, JSON.stringify(record('0.1.1', candidate))); clock += 60001; await writeFile(clockFile, String(clock));
  const divergentIndex = await readFile(join(checkout, '.git/index')); const divergentBytes = await readFile(source);
  const diverged = await rpc('check'); assert.equal(diverged.observation.local.outcome, 'cannot_establish'); assert.deepEqual(await readFile(join(checkout, '.git/index')), divergentIndex); assert.deepEqual(await readFile(source), divergentBytes);
  await writeFile(feedFile, 'fail'); clock += 60001; await writeFile(clockFile, String(clock)); const failed = await rpc('check'); assert.equal(failed.stale, true); assert.equal(failed.feedFailure, 'unavailable');
  const logs = await cli('plugin', 'logs', 'pa-updates'); assert.match(logs, /stage=feed outcome=unavailable/); assert.ok(!logs.includes('PRIVATE_SENTINEL')); assert.ok(!JSON.stringify(failed).includes('PRIVATE_SENTINEL'));
  const callsBeforeReload = await readFile(countFile, 'utf8'); await cli('plugin', 'reload', 'pa-updates'); await rpc('status'); assert.equal(await readFile(countFile, 'utf8'), callsBeforeReload);
  // Real footer, real bundles, synthetic typed RPC states below.
  browser = await chromium.launch({ headless: true, ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : {}) });
  const base = { ...initial, checking: false, comparison: 'current', storageFailure: false, stale: false, feedFailure: null, nextManualAt: null,
    observation: { ...initial.observation, installed: { version: '0.1.1', revision: baseline, source: 'trusted' }, release: record('0.1.1', baseline) } };
  base.observation.release.plugins[0].notes = 'Synthetic release evidence only.\n<script>inert text, not markup</script>\n' + 'Readable notes. '.repeat(40);
  const views = ['first', 'checking', 'current', 'available', 'absent', 'unknown', 'dirty', 'diverged', 'stale', 'invalid', 'revision', 'incompatible', 'inventory', 'recovery', 'no_release', 'mismatch', 'newer', 'rpc_error', 'storage'];
  let screenshots = 0;
  for (const view of views) for (const width of [1280, 390]) {
    console.log(`Rendering synthetic ${view} at ${width}`);
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.on('pageerror', error => console.error('Synthetic page error:', error.message)); let state = structuredClone(base); let checks = 0;
    if (view === 'first') Object.assign(state, { comparison: 'first', observation: null, lastSuccess: null, lastAttempt: null });
    if (view === 'checking') state.checking = true;
    if (view === 'available') { state.comparison = 'available'; state.observation.installed.version = '0.1.0'; }
    if (view === 'absent') { state.comparison = 'no_plugin'; state.observation.installed = null; }
    if (view === 'unknown') state.observation.local = { ...state.observation.local, outcome: 'not_assessed', reason: 'mapping_missing' };
    if (view === 'dirty') state.observation.local.outcome = 'local_changes';
    if (view === 'diverged') Object.assign(state.observation.local, { outcome: 'cannot_establish', reason: 'diverged' });
    if (['stale', 'invalid', 'recovery'].includes(view)) Object.assign(state, { stale: true, feedFailure: view === 'invalid' ? 'invalid' : 'network', lastAttempt: new Date(clock).toISOString() });
    if (view === 'revision') { state.comparison = 'revision_unavailable'; state.observation.installed.revision = null; }
    if (view === 'incompatible') state.comparison = 'incompatible';
    if (view === 'no_release') { state.comparison = 'no_release'; state.observation.release = null; }
    if (view === 'mismatch') state.comparison = 'source_mismatch';
    if (view === 'newer') { state.comparison = 'installed_newer'; state.observation.installed.version = '0.2.0'; }
    if (view === 'storage') state.storageFailure = true;
    if (view === 'inventory') { state.comparison = 'inventory_unavailable'; delete state.observation.installed; state.observation.inventoryFailed = true; }
    await page.route('**/api/v1/plugins/pa-updates/rpc/**', route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1); assert.ok(['check', 'status'].includes(method));
      if (method === 'check') { checks++; if (view === 'recovery') { state = structuredClone(base); } }
      return route.fulfill({ json: view === 'rpc_error' ? { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL private response' } } : { ok: true, result: state } });
    });
    await page.goto(env.BB_SERVER_URL); await page.getByText('Learn what bb can do', { exact: true }).waitFor({ timeout: 60000 }); const trigger = page.getByRole('button', { name: 'PA updates', exact: true });
    if (width === 390 && await page.locator('main[data-sidebar-shelf="closed"]').count()) { await page.getByRole('button', { name: /Toggle sidebar/ }).click(); await page.locator('main[data-sidebar-shelf="open"]').waitFor(); }
    await trigger.waitFor({ timeout: 60000 }); await trigger.click({ trial: true }); await trigger.focus(); await page.keyboard.press('Enter');
    await page.screenshot({ path: join(artifacts, 'last-open.png') });
    const section = page.getByRole('region', { name: 'Google Calendar updates', exact: true }); await section.waitFor();
    await section.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.pa-updates')?.textContent.includes('Loading check status'));
    assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(!(await section.textContent()).includes('PRIVATE_SENTINEL'));
    assert.ok(await section.locator('[role="status"][aria-live="polite"]').count() > 0);
    assert.equal(await section.getByRole('button', { name: /install|apply|approve/i }).count(), 0); assert.equal(await section.locator('script,a').count(), 0);
    await page.waitForFunction(() => { const el = document.querySelector('.pa-updates'); if (!el) return false; const host = el.closest('[id^="plugin-sidebar-footer-disclosure-"]').getBoundingClientRect(); const own = el.getBoundingClientRect(); const check = el.querySelector('footer button').getBoundingClientRect(); return own.bottom <= host.bottom + 1 && check.bottom <= host.bottom && check.top >= host.top; });
    if (view === 'stale' || view === 'invalid') await section.getByText(/Last known release information/).waitFor();
    if (view === 'available') await section.getByText('Google Calendar update available', { exact: true }).waitFor();
    if (view === 'absent') await section.getByText('No supported plugin installed', { exact: true }).waitFor();
    if (view === 'recovery') { await section.getByRole('button', { name: 'Check again' }).click(); await section.getByText(/Last known release information/).waitFor({ state: 'hidden' }); assert.equal(checks, 1); }
    const close = section.getByRole('button', { name: 'Close PA updates' }); await page.keyboard.press('Tab'); await close.focus(); assert.equal(await close.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await page.mouse.move(width - 10, 10); await page.screenshot({ path: join(artifacts, `${view}-${width}.png`) }); screenshots++;
    if (view === 'available') {
      for (const label of ['Release notes', 'Source revisions and requirements']) {
        const detail = section.locator('summary', { hasText: label }); await detail.scrollIntoViewIfNeeded(); await detail.focus(); await page.keyboard.press('Enter');
        assert.equal(await detail.evaluate(el => el.parentElement.open), true);
        assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false);
        await page.screenshot({ path: join(artifacts, `${label.startsWith('Release') ? 'notes' : 'source'}-${width}.png`) }); screenshots++;
      }
    }
    await page.keyboard.press('Escape'); await section.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Host must restore focus to disclosure trigger');
    await page.close();
  }
  await browser.close(); browser = null;
  await cli('plugin', 'disable', 'pa-updates'); const stoppedCalls = await readFile(countFile, 'utf8');
  const after = JSON.parse(await cli('plugin', 'list', '--json')).plugins; assert.equal(after.find(p => p.id === 'pa-updates').status, 'disabled'); assert.equal(after.find(p => p.id === 'google-calendar').status, 'running'); assert.equal(await readFile(countFile, 'utf8'), stoppedCalls);
  const result = { evidence: 'Synthetic; generated older installation and release data, no production downgrade', bb: '0.45.0', sdk: '0.6.15', screenshots, typedRpc: true, boundedDiagnostic: true, unchangedCheckout: true, joinedChecks: true, restartCooldown: true, desktopAndNarrowKeyboard: true, artifacts };
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2)); completed = true; console.log(JSON.stringify(result));
} finally {
  await browser?.close(); if (server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 10000))]); }
  if (server.exitCode === 0 && completed) await rm(root, { recursive: true, force: true }); else console.error('Retained disposable host/evidence:', root, artifacts);
}
