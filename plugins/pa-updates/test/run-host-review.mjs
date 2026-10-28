// Real disposable BB + original app, synthetic validated RPC states. No account
// connections, provider writes, source updates or runtime installations.
import assert from 'node:assert/strict';
import { mkdir, cp, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createGateHost } from './gate-host.mjs';
import { applicationStatusSchema, switchSourceInputSchema, acknowledgeSourceRecoveryInputSchema, installedSourcesSchema } from '../core/application-model.ts';
import { componentIds } from '../core/workspace.ts';
const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const host = await createGateHost(process.env.BB_REVIEW_PACKAGE ?? join(source, 'node_modules/bb-app'));
const artifacts = await mkdtemp(join(tmpdir(), 'pa-source-modes-ui-'));
let browser, completed = false, screenshots = 0;
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), reviewId = '11111111-1111-4111-8111-111111111111';
function current() {
  const components = Object.fromEntries(componentIds.map(id => [id, { local: false, upstream: false, working: a, origin: a }]));
  return { checking: false, applying: false, failure: null, job: null, progress: null, offers: { available: false, checkedAt: new Date().toISOString() }, review: {
    id: reviewId, at: new Date().toISOString(), rows: [], localRows: [], workspace: { head: 'a'.repeat(40), originHead: 'a'.repeat(40), dirty: false, ahead: false, behind: false, configuredOrigin: 'https://github.com/mattwynne/pa-bb.git', originComparisonMatches: true, components },
    inventory: componentIds.map(id => ({ id, installed: '1.0.0', local: 'stock', sourceMode: 'managed', sourceEnabled: true, sourceSwitchSupported: true, sourceGeneration: c, state: 'current', prerequisite: null, workspace: components[id], applied: a, originComparisonMatches: true })),
    runtime: { target: { id: 'fixture-host', name: 'PA test server' }, runningThreadCount: 0, rows: ['pi', 'codex', 'bb'].map(id => ({ id, installed: '1.0.0', available: null, source: id === 'bb' ? 'npm' : 'npmGlobal', fingerprint: id, state: 'current', reason: null })) },
  } };
}
function offer(state, id = 'google-calendar') {
  const row = state.review.inventory.find(row => row.id === id);
  return { ...row, available: '1.0.0', fingerprint: c, targetFingerprint: row.workspace.origin };
}
function makeState(view) {
  const state = current(), row = state.review.inventory.find(row => row.id === 'google-calendar'), work = row.workspace;
  if (['local', 'both'].includes(view)) {
    row.sourceMode = 'local'; Object.assign(work, { local: true, working: b }); row.applied = null; state.review.workspace.dirty = true;
    state.review.localRows = [{ ...offer(state), targetFingerprint: b, prerequisite: null }];
  }
  if (['incoming', 'both', 'consent'].includes(view)) {
    work.upstream = true; work.origin = view === 'both' ? c : b;
    state.review.workspace.behind = true; state.review.workspace.originHead = 'b'.repeat(40); row.state = 'offered';
    state.review.rows = [{ ...offer(state), local: view === 'both' ? 'unknown' : 'stock', prerequisite: view === 'both' ? 'source_work' : null }];
    state.offers.available = true;
  }
  if (view === 'unapplied') {
    Object.assign(work, { working: b, origin: b }); row.sourceMode = 'managed'; row.state = 'offered';
    state.review.rows = [offer(state)]; state.offers.available = true;
  }
  if (view === 'unconfirmed') { row.applied = null; state.review.localRows = [offer(state)]; }
  if (view === 'source_only') { state.review.workspace.behind = true; state.review.workspace.originHead = 'b'.repeat(40); state.offers.available = true; }
  if (view === 'progress' || view.startsWith('progress_origin_')) { state.checking = true; state.progress = { id: '44444444-4444-4444-8444-444444444444', requested: true, integrations: [], integrationsDone: false, runtime: [], runtimeDone: false, target: null }; }
  if (view === 'consent') { state.review.runtime.runningThreadCount = 2; Object.assign(state.review.runtime.rows[2], { state: 'ready', available: '1.0.1' }); }
  if (view === 'uncertain') {
    state.job = { id: '22222222-2222-4222-8222-222222222222', reviewId, mode: 'local', phase: 'attention', receipts: [{ id: 'icloud', choice: 'install', before: '1.0.0', preview: '1.0.0', actual: null, outcome: 'uncertain' }],
      syncReserved: true, failure: 'interrupted', runtimeReceipts: [], bbIntent: null, selfIntent: null, confirmInterruptingThreads: false };
  }
  if (view === 'source_local') state.review.inventory.forEach(row => row.sourceMode = 'local');
  if (view.startsWith('local_')) {
    row.sourceMode = 'local';
    state.review.workspace.dirty = ['local_dirty', 'local_both'].includes(view);
    state.review.workspace.ahead = ['local_ahead', 'local_both', 'local_unknown', 'local_mismatch'].includes(view);
    if (view === 'local_origin' || view === 'local_mismatch') state.review.workspace.configuredOrigin = 'https://github.com/example/working-fork.git';
    if (view === 'local_unknown') delete state.review.workspace.configuredOrigin;
    if (['local_unknown', 'local_mismatch'].includes(view)) state.review.workspace.originComparisonMatches = row.originComparisonMatches = false;
    if (view === 'local_legacy') delete row.originComparisonMatches;
  }
  if (view === 'source_capability_false') state.review.inventory.forEach(row => row.sourceSwitchSupported = false);
  if (view === 'source_capability_missing') state.review.inventory.forEach(row => delete row.sourceSwitchSupported);
  if (view === 'source_disabled') state.review.inventory.forEach(row => row.sourceEnabled = false);
  if (view === 'source_managed_separately') Object.assign(state.review.runtime.rows.find(row => row.id === 'bb'), { state: 'unavailable', source: 'unknown', reason: 'unsupported_install' });
  if (view === 'source_missing_enablement') state.review.inventory.forEach(row => delete row.sourceEnabled);
  if (view === 'source_missing_generation') state.review.inventory.forEach(row => delete row.sourceGeneration);
  if (view === 'source_unsupported') state.review.inventory.forEach(row => row.sourceMode = 'unsupported');
  if (view === 'source_no_workspace') { state.review.workspace = null; state.review.inventory.forEach(row => { row.workspace = null; delete row.originComparisonMatches; }); }
  if (view.startsWith('progress_origin_')) {
    row.sourceMode = 'local';
    state.review.workspace.originComparisonMatches = row.originComparisonMatches = view !== 'progress_origin_verified';
    const fresh = structuredClone(row);
    if (view === 'progress_origin_absent') delete fresh.originComparisonMatches;
    else fresh.originComparisonMatches = view === 'progress_origin_verified';
    state.progress.integrations = [fresh];
  }
  if (view === 'source_busy') state.applying = true;
  if (view === 'source_error') state.failure = 'unavailable';
  if (view === 'source_pending') { state.sourceSwitch = sourceReceipt('google-calendar', 'local', 'running'); state.applying = true; }
  if (['source_failed_local', 'source_failed_github', 'source_recovery_aborted', 'source_recovery_waiting', 'source_recovery_rpc_refused'].includes(view)) {
    const target = view === 'source_failed_github' ? 'github' : 'local';
    if (target === 'github') row.sourceMode = 'local';
    state.sourceSwitch = { ...sourceReceipt('google-calendar', target, 'attention'), reason: 'install_failed', removalAttempted: false, removed: false, installAdmitted: true, manualRecovery: true, configuration: 'preserved', syncReserved: true, pauseHandoff: true };
  }
  if (['source_legacy_deleted', 'source_legacy_possible', 'source_legacy_planned'].includes(view)) state.sourceSwitch = { ...sourceReceipt('google-calendar', 'local', 'attention'), reason: 'install_failed', removalAttempted: true, removed: true, installAdmitted: true, manualRecovery: true, configuration: view === 'source_legacy_possible' ? 'possibly_deleted' : view === 'source_legacy_planned' ? 'reset_expected' : 'deleted', syncReserved: true, pauseHandoff: true };
  if (view === 'source_recovery_aborted') Object.assign(state.sourceSwitch, { reason: 'pause_incomplete', removalAttempted: false, removed: false, installAdmitted: false, configuration: 'preserved', pauseHandoff: false });
  if (view === 'source_complete_stale') {
    row.state = 'offered'; Object.assign(work, { local: true, working: b });
    state.review.rows = [{ ...offer(state), available: '1.1.0' }]; state.review.localRows = [offer(state)];
    state.sourceSwitch = sourceReceipt('google-calendar', 'local', 'running'); finishSource(state);
  }
  if (view === 'source_not_started') state.sourceSwitch = { ...sourceReceipt('google-drive', 'local', 'attention'), reviewId: '99999999-9999-4999-8999-999999999999', reason: 'unsupported' };
  if (view === 'source_dependencies') state.sourceSwitch = { ...sourceReceipt('google-calendar', 'local', 'attention'), reason: 'dependencies_missing' };
  return applicationStatusSchema.parse(state);
}
function installedSources(state) {
  const rows = state.review.inventory.map(row => ({ id: row.id, installed: row.installed, sourceMode: row.sourceMode ?? null, sourceGeneration: row.sourceGeneration ?? null, sourceEnabled: row.sourceEnabled ?? true }));
  const receipt = state.sourceSwitch;
  if (receipt?.phase === 'complete' && receipt.reviewId === state.review.id) Object.assign(rows.find(row => row.id === receipt.id), { installed: receipt.actual, sourceMode: receipt.target === 'local' ? 'local' : 'managed', sourceGeneration: b });
  return installedSourcesSchema.parse(rows);
}
function sourceReceipt(id, target, phase) {
  return { jobId: '55555555-5555-4555-8555-555555555555', reviewId, id, target, phase, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reason: null,
    removalAttempted: false, removed: false, installAdmitted: false, pauseHandoff: false, syncReserved: false, manualRecovery: false, configuration: 'preserved', actual: null };
}
function finishSource(state) {
  state.applying = false;
  Object.assign(state.sourceSwitch, { phase: 'complete', reason: null, actual: '2.0.0', configuration: 'preserved', removalAttempted: false, removed: false, installAdmitted: true, manualRecovery: false, syncReserved: false });
}
async function settle(panel) {
  await panel.evaluate(async element => {
    let previous = '', stable = 0; const deadline = performance.now() + 5000;
    while (stable < 3) {
      await new Promise(requestAnimationFrame); const box = element.getBoundingClientRect();
      const position = JSON.stringify([box.x, box.y, box.width, box.height]);
      stable = position === previous ? stable + 1 : 0; previous = position;
      if (performance.now() > deadline) throw new Error('BB layout did not settle');
    }
  });
}
function finishJob(state, mode) {
  const candidates = mode === 'local' ? state.review.localRows : state.review.rows.filter(row => row.local === 'stock' && !row.prerequisite);
  state.job = { id: '22222222-2222-4222-8222-222222222222', reviewId: state.review.id, mode, phase: 'complete', receipts: candidates.map(row => ({ id: row.id, choice: 'install', before: row.installed, preview: row.available, actual: row.available, outcome: 'updated' })),
    syncReserved: false, failure: null, runtimeReceipts: mode === 'origin' ? state.review.runtime.rows.filter(row => row.state === 'ready').map(row => ({ id: row.id, before: row.installed, preview: row.available, actual: row.available, source: row.source, outcome: 'updated' })) : [], bbIntent: null, selfIntent: null, confirmInterruptingThreads: mode === 'origin' };
  if (mode === 'origin' && state.review.workspace.behind) state.job.sourceUpdate = { before: state.review.workspace.head, target: state.review.workspace.originHead, actual: state.review.workspace.originHead, outcome: 'updated', reason: null };
  state.offers = null;
}
try {
  const fixture = join(host.root, 'fixture');
  await cp(source, fixture, { recursive: true, filter: path => !['node_modules', 'dist', 'test', 'features'].some(part => path.slice(source.length).split('/').includes(part)) });
  await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'));
  await writeFile(join(fixture, 'implementation.ts'), await import('node:fs/promises').then(fs => fs.readFile(join(source, 'server.ts'))));
  await writeFile(join(fixture, 'server.ts'), `import plugin from'./implementation.ts';import{z}from'zod';export default async bb=>{
await plugin(bb,undefined,{inspect:async()=>[],validateMix:async()=>{},update:async()=>{throw new Error('Rendered fixture cannot activate')},quiesce:async()=>{},restore:async()=>{},load:async()=>null,save:async()=>{},diagnose(){}});
bb.rpc.register({fixtureNotify:{input:z.null(),output:z.null()}},{fixtureNotify:async()=>{await bb.realtime.publish('application',null);return null}})};`);
  await host.start();
  for (const path of [resolve(source, '../google-calendar'), fixture]) {
    const installed = JSON.parse(await host.cli('plugin', 'install', path, '--yes', '--json')); assert.equal(installed.plugin.status, 'running');
  }
  browser = await chromium.launch({ headless: true, ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : { channel: 'chrome' }) });
  const notify = async () => { const value = await host.request('plugins/pa-updates/rpc/fixtureNotify', null); assert.equal(value.body.ok, true); };
  const views = process.env.BB_REVIEW_VIEWS?.split(',') ?? ['current', 'local', 'incoming', 'both', 'unapplied', 'unconfirmed', 'progress', 'consent', 'source_only', 'failed_check', 'uncertain',
    'source_managed', 'source_local', 'source_not_started', 'local_origin', 'local_dirty', 'local_ahead', 'local_both', 'local_unknown', 'local_mismatch',
    'source_managed_separately', 'source_legacy_deleted', 'source_legacy_possible', 'source_legacy_planned', 'source_capability_false', 'source_capability_missing', 'source_disabled', 'source_missing_enablement', 'source_missing_generation', 'source_unsupported', 'source_no_workspace', 'source_busy', 'source_error',
    'source_pending', 'source_failed_local', 'source_failed_github', 'source_recovery_aborted', 'source_recovery_waiting', 'source_dependencies', 'source_complete_stale',
    'source_switch_refused', 'source_switch_lost_response', 'source_recovery_rpc_refused', 'progress_origin_false', 'progress_origin_absent', 'progress_origin_verified', 'local_legacy', 'source_status_read_failure', 'source_external', 'source_snapshot_failure', 'source_partial_failure', 'source_removed'];
  for (const view of views) for (const width of [1280, 390]) {
    let state = makeState(view), reviews = 0, rpcCalls = 0, failStatus = false, failSources = false, externalSources = null; const writes = [], errors = [];
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/plugins/pa-updates/rpc/**', async route => {
      rpcCalls++;
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.ok(['status', 'applicationStatus', 'installedSources', 'review', 'apply', 'applyLocal', 'resumeSync', 'switchSource', 'acknowledgeSourceRecovery'].includes(method));
      if (method === 'installedSources') {
        if (failSources) return route.fulfill({ json: { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL' } } });
        return route.fulfill({ json: { ok: true, result: installedSourcesSchema.parse(externalSources ?? installedSources(state)) } });
      }
      if (method === 'applicationStatus' && failStatus) {
        return route.fulfill({ json: { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL' } } });
      }
      if (['review', 'apply', 'applyLocal', 'resumeSync', 'switchSource', 'acknowledgeSourceRecovery'].includes(method)) writes.push({ method, input: route.request().postDataJSON() });
      if (method === 'switchSource') {
        const input = switchSourceInputSchema.parse(route.request().postDataJSON());
        if (view !== 'source_switch_refused' || writes.filter(write => write.method === 'switchSource').length > 1) {
          state.sourceSwitch = sourceReceipt(input.id, input.target, 'preparing'); state.applying = true;
        }
        if (['source_switch_refused', 'source_switch_lost_response'].includes(view) && writes.filter(write => write.method === 'switchSource').length === 1)
          return route.fulfill({ json: { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL' } } });
      }
      if (method === 'acknowledgeSourceRecovery') {
        assert.deepEqual(acknowledgeSourceRecoveryInputSchema.parse(route.request().postDataJSON()), { jobId: state.sourceSwitch.jobId });
        if (view === 'source_recovery_rpc_refused' && writes.filter(write => write.method === 'acknowledgeSourceRecovery').length === 1)
          return route.fulfill({ json: { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL' } } });
        if (view === 'source_recovery_aborted') Object.assign(state.sourceSwitch, { recovery: 'original_verified', manualRecovery: false, syncReserved: false, pauseHandoff: true, actual: '1.0.0' });
        else if (view !== 'source_recovery_waiting' || writes.filter(write => write.method === 'acknowledgeSourceRecovery').length > 1) { finishSource(state); state.sourceSwitch.recovery = 'target_verified'; }
      }
      if (method === 'review') {
        reviews++; if (view === 'failed_check' && reviews === 1) return route.fulfill({ json: { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL' } } });
        state.review.id = '33333333-3333-4333-8333-333333333333';
        if (state.sourceSwitch?.phase === 'complete') {
          const row = state.review.inventory.find(row => row.id === state.sourceSwitch.id);
          Object.assign(row, { sourceMode: state.sourceSwitch.target === 'github' ? 'managed' : 'local', installed: state.sourceSwitch.actual });
        }
      }
      if (method === 'apply' || method === 'applyLocal') finishJob(state, method === 'applyLocal' ? 'local' : 'origin');
      if (method === 'resumeSync') state.job.syncReserved = false;
      await route.fulfill({ json: { ok: true, result: applicationStatusSchema.parse(state) } });
    });
    await page.goto(host.env.BB_SERVER_URL); await page.locator('button').first().waitFor({ timeout: 60000 });
    const skip = page.getByRole('button', { name: 'Skip setup', exact: true }); if (await skip.isVisible()) await skip.click();
    if (width === 390 && await page.locator('main[data-sidebar-shelf="closed"]').count()) await page.getByRole('button', { name: /Toggle sidebar/ }).click();
    const footer = page.getByRole('button', { name: 'PA updates', exact: true }); await footer.waitFor({ timeout: 60000 }); await footer.focus(); await page.keyboard.press('Enter');
    await page.waitForURL('**/settings/plugins/pa-updates'); const panel = page.locator('.pa-updates'); await panel.waitFor();
    await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('PA updater'));
    assert.equal(writes.length, 0, 'opening Settings never applies or starts another check');
    assert.equal(await panel.locator('.pa-update-card').count(), 9);
    const text = await panel.innerText(); assert.ok(!/Install released|Release notes|PRIVATE_SENTINEL/.test(text));
    if (view === 'current') assert.equal(await panel.locator('.pa-update-check').count(), 9);
    if (view === 'source_managed_separately') { assert.ok(text.includes('Managed separately')); assert.ok(!text.includes('Couldn’t check')); assert.equal(await panel.locator('.pa-update-check').count(), 8); }
    if (view === 'local') { assert.ok(text.includes('Local changes')); assert.equal(await panel.getByRole('button', { name: 'Update PA', exact: true }).count(), 0); }
    if (view === 'both') { assert.ok(text.includes('Local and upstream changes')); assert.equal(await panel.getByRole('button', { name: 'Update PA', exact: true }).count(), 0); }
    if (view === 'unapplied') assert.ok(text.includes('Changes ready to apply'));
    if (view === 'unconfirmed') assert.equal(await panel.locator('.pa-update-check').count(), 8);
    if (view === 'incoming') { assert.ok(text.includes('Updates available')); assert.ok(!text.includes('1.0.0 → 1.0.0')); }
    if (view === 'source_only') { assert.ok(text.includes('working copy has updates')); assert.equal(await panel.getByRole('button', { name: 'Update PA', exact: true }).isEnabled(), true); }
    if (view === 'progress') {
      assert.equal(await panel.locator('.pa-update-spinner').count(), 9);
      state.progress.integrations.push(state.review.inventory[0]); await notify();
      await page.waitForFunction(() => document.querySelectorAll('.pa-updates .pa-update-spinner').length === 8);
      assert.equal(await panel.locator('.pa-update-check').count(), 1);
    }
    if (view.startsWith('progress_origin_')) {
      assert.equal(await panel.locator('.pa-update-spinner').count(), 8);
      const fresh = panel.locator('[data-check-id="google-calendar"]');
      assert.equal(await fresh.locator('.pa-update-check').count(), view === 'progress_origin_verified' ? 1 : 0, 'only the fresh local row can verify origin agreement');
      assert.ok((await fresh.innerText()).includes(view === 'progress_origin_verified' ? 'Up to date' : 'Couldn’t check'));
    }
    if (view === 'consent') {
      const button = panel.getByRole('button', { name: 'Update PA', exact: true }); assert.equal(await button.isEnabled(), false);
      const consent = panel.getByRole('checkbox'); await consent.focus(); await page.keyboard.press('Space'); assert.equal(await button.isEnabled(), true);
    }
    if (view === 'uncertain') { assert.ok(text.includes('Result uncertain')); assert.equal(await panel.getByRole('button', { name: 'Resume previously enabled folders' }).count(), 1); }
    if (view === 'failed_check') {
      await panel.getByRole('button', { name: 'Check again' }).click();
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Update status unavailable'));
      const reread = page.waitForResponse(response => response.url().endsWith('/rpc/applicationStatus')); await notify(); await reread;
      await page.waitForFunction(() => !document.querySelector('.pa-updates')?.textContent.includes('Update status unavailable'));
      assert.equal(await panel.locator('.pa-update-check').count(), 0, 'old successful read cannot undo a failed check');
      await panel.getByRole('button', { name: 'Check again' }).click(); await page.waitForFunction(() => document.querySelectorAll('.pa-updates .pa-update-check').length === 9);
    }
    if (view === 'source_status_read_failure') {
      failStatus = true; await notify();
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Could not read the saved result'));
      assert.equal(await panel.locator('.pa-update-check').count(), 0);
      assert.ok(!(await panel.innerText()).includes('PRIVATE_SENTINEL'));
      await page.screenshot({ path: join(artifacts, `${view}-unavailable-${width}.png`), fullPage: true }); screenshots++;
      failStatus = false; await notify();
      await page.waitForFunction(() => !document.querySelector('.pa-updates')?.textContent.includes('Could not read the saved result'));
      assert.equal(await panel.locator('.pa-update-check').count(), 0, 'old read does not undo a status-read failure');
      assert.equal(writes.length, 0);
      await panel.getByRole('button', { name: 'Check again' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.pa-updates .pa-update-check').length === 9);
    }
    if (view === 'source_external') {
      const row = panel.locator('[data-source-id="google-drive"]');
      const switchButton = row.getByRole('button', { name: 'Switch Google Drive to Local development' });
      await switchButton.click(); await page.getByRole('dialog', { name: /Switch Google Drive/ }).waitFor();
      externalSources = installedSources(state);
      Object.assign(externalSources.find(row => row.id === 'google-drive'), { sourceMode: 'local', sourceGeneration: b });
      // Real host system:changed event, not the updater's application signal.
      await host.cli('plugin', 'disable', 'google-calendar');
      await page.waitForFunction(() => document.querySelector('[data-source-id="google-drive"] .pa-update-source-line')?.textContent.includes('Local developmentSwitch to GitHub'));
      assert.equal(await page.getByRole('dialog', { name: /Switch Google Drive/ }).count(), 0, 'external change closes stale confirmation');
      assert.equal(await row.locator('.pa-update-check').count(), 0, 'old applied-code claim is not transferred to a new source');
      assert.ok((await row.innerText()).includes('Code unverified'));
      assert.equal(await row.getByRole('button', { name: 'Switch Google Drive to GitHub' }).isEnabled(), false);
      assert.equal(writes.length, 0, 'notifications never review, install, reload or apply');
      const savedReview = structuredClone(state.review), savedJob = structuredClone(state.job);
      Object.assign(externalSources.find(row => row.id === 'google-drive'), { sourceMode: 'managed', sourceGeneration: c });
      await host.cli('plugin', 'enable', 'google-calendar');
      await page.waitForFunction(() => document.querySelector('[data-source-id="google-drive"] .pa-update-source-line')?.textContent.includes('GitHubSwitch to Local development'));
      assert.equal(await row.getByRole('button', { name: 'Switch Google Drive to Local development' }).isEnabled(), true);
      assert.deepEqual(state.review, savedReview); assert.deepEqual(state.job, savedJob);
      // A change made while the page was closed is picked up when reopening.
      Object.assign(externalSources.find(row => row.id === 'google-drive'), { sourceMode: 'local', sourceGeneration: b });
      await page.reload(); await page.locator('.pa-updates [data-source-id="google-drive"]').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-source-id="google-drive"] .pa-update-source-line')?.textContent.includes('Local developmentSwitch to GitHub'));
      assert.equal(writes.length, 0);
    }
    if (['source_snapshot_failure', 'source_partial_failure', 'source_removed'].includes(view)) {
      if (view === 'source_snapshot_failure') failSources = true;
      else {
        externalSources = installedSources(state);
        if (view === 'source_removed') externalSources = externalSources.filter(row => row.id !== 'google-drive');
        else Object.assign(externalSources.find(row => row.id === 'google-drive'), { sourceMode: null, sourceGeneration: null });
      }
      await notify();
      await page.waitForFunction(() => document.querySelector('[data-source-id="google-drive"]')?.textContent.includes('Source unavailable'));
      assert.equal(await panel.locator('[data-source-id="google-drive"] .pa-update-check').count(), 0);
      assert.ok(!(await panel.innerText()).includes('PRIVATE_SENTINEL'));
      if (view === 'source_removed') assert.ok((await panel.locator('[data-source-id="google-drive"]').innerText()).includes('Not installed'));
      assert.equal(writes.length, 0);
      await page.screenshot({ path: join(artifacts, `${view}-unavailable-${width}.png`), fullPage: true }); screenshots++;
      failSources = false; externalSources = null; await notify();
      await page.waitForFunction(() => document.querySelector('[data-source-id="google-drive"] .pa-update-check'));
    }
    // BB animates the narrow sidebar shelf after navigation. Wait for geometry,
    // not a guessed delay, before judging or capturing the finished layout.
    await settle(panel);
    assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth + 1), true, 'no horizontal overflow or clipped panel');
    await page.screenshot({ path: join(artifacts, `${view}-${width}.png`), fullPage: true }); screenshots++;
    if (await panel.evaluate(element => element.getBoundingClientRect().bottom > innerHeight)) {
      await panel.getByRole('button', { name: 'Check again' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `${view}-${width}-bottom.png`) }); screenshots++;
    }
    const sourceButtons = panel.locator('.pa-update-source-action');
    if (view.startsWith('local_')) {
      const localRow = panel.locator('[data-source-id="google-calendar"]'), facts = await localRow.locator('.pa-update-source-facts').innerText();
      assert.ok(facts.includes(['local_dirty', 'local_both'].includes(view) ? 'Edited files' : 'No edited files'));
      assert.ok(facts.includes(['local_unknown', 'local_mismatch'].includes(view) ? 'Unpushed commits unverified' : ['local_ahead', 'local_both'].includes(view) ? 'Unpushed commits' : 'No unpushed commits'));
      if (view === 'local_unknown') assert.ok(facts.includes('Origin: Unavailable'));
      if (view === 'local_origin' || view === 'local_mismatch') assert.ok(facts.includes('https://github.com/example/working-fork.git'));
      if (['local_unknown', 'local_mismatch', 'local_legacy'].includes(view)) assert.equal(await localRow.locator('.pa-update-check').count(), 0, 'unverified origin cannot earn a green agreement');
    }
    if (['source_capability_false', 'source_capability_missing', 'source_disabled', 'source_missing_enablement', 'source_missing_generation', 'source_no_workspace', 'source_busy', 'source_error', 'source_dependencies', 'uncertain'].includes(view)) {
      assert.equal(await sourceButtons.count(), 6);
      for (const button of await sourceButtons.all()) assert.equal(await button.isEnabled(), false);
      if (['source_capability_false', 'source_capability_missing'].includes(view)) assert.ok(text.includes('Some source switches could not be verified on this BB and remain disabled.'));
      if (view === 'source_disabled') assert.ok(text.includes('Enable this plugin in BB first'));
      if (view === 'source_dependencies') assert.ok(text.includes('run npm ci'));
    }
    if (view === 'source_not_started') {
      assert.ok(text.includes('Switch did not start')); assert.ok(!text.includes('after updating BB'));
      assert.equal(await panel.locator('[data-source-id="google-drive"] .pa-update-source-action').isEnabled(), true);
      assert.ok(!(await panel.locator('[data-source-id="google-drive"]').innerText()).includes('Source needs attention'));
    }
    if (view === 'source_unsupported') assert.equal(await sourceButtons.count(), 0);
    if (['source_managed', 'source_local'].includes(view)) {
      assert.equal(await panel.getByRole('button', { name: 'Update PA', exact: true }).count(), 0, 'switches do not depend on an offer');
      for (const id of componentIds) {
        const row = panel.locator(`[data-source-id="${id}"]`), button = row.locator('.pa-update-source-action');
        assert.equal(await button.isEnabled(), true);
        const beforeDialog = rpcCalls;
        await button.click(); const dialog = panel.getByRole('dialog'); await dialog.waitFor();
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true }), confirm = dialog.getByRole('button', { name: 'Switch source', exact: true });
        assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
        const warning = await dialog.innerText();
        assert.ok(warning.includes(id === 'google-calendar' ? 'Calendar' : id === 'pa-updates' ? 'PA updater' : id === 'google-drive' ? 'Google Drive' : id === 'icloud' ? 'iCloud' : id === 'obsidian' ? 'Obsidian' : 'Fastmail'));
        assert.ok(warning.includes(view === 'source_managed' ? 'to Local development?' : 'to GitHub?'));
        for (const phrase of ['Settings and data stay', 'Source files and commits are kept', 'including edited files', 'nothing is committed, pushed or reset']) assert.ok(warning.includes(phrase));
        assert.equal(warning.includes('Do not edit this plugin until the switch finishes.'), view === 'source_managed');
        if (['icloud', 'obsidian'].includes(id)) assert.ok(warning.includes('Only previously enabled folders resume after verification'));
        if (id === 'pa-updates') {
          assert.ok(warning.includes('reloads this page')); assert.ok(warning.includes('Keep these instructions outside BB'));
          assert.ok(warning.includes(view === 'source_managed' ? 'path:$HOME/src/pa-bb/plugins/pa-updates' : 'git:https://github.com/mattwynne/pa-bb.git@main --subdirectory plugins/pa-updates'));
        }
        await page.keyboard.press('Shift+Tab'); assert.equal(await confirm.evaluate(element => element === document.activeElement), true, `Reverse Tab focus: ${await page.evaluate(() => document.activeElement?.tagName)}`);
        await page.keyboard.press('Tab'); assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Tab'); assert.equal(await confirm.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Tab'); assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
        assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().left >= 15 && element.getBoundingClientRect().right <= innerWidth - 15 && element.getBoundingClientRect().top >= 15 && element.getBoundingClientRect().bottom <= innerHeight - 15), true);
        await page.screenshot({ path: join(artifacts, `${view}-${id}-warning-${width}.png`) }); screenshots++;
        await cancel.click(); await dialog.waitFor({ state: 'detached' });
        assert.equal(await button.evaluate(element => element === document.activeElement), true);
        assert.equal(writes.length, 0, 'Cancel has no RPC writes');
        await button.click(); await dialog.waitFor(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
        assert.equal(await button.evaluate(element => element === document.activeElement), true);
        assert.equal(writes.length, 0, 'Escape has no RPC writes');
        assert.equal(rpcCalls, beforeDialog, 'opening, Cancel and Escape make no RPC calls');
      }
      const row = panel.locator('[data-source-id="google-calendar"]');
      await row.locator('.pa-update-source-action').click();
      await panel.getByRole('button', { name: 'Switch source', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pa-update-source-result')?.textContent.includes('Switching source'));
      assert.deepEqual(writes, [{ method: 'switchSource', input: { reviewId, id: 'google-calendar', target: view === 'source_managed' ? 'local' : 'github', confirmSwitch: true } }]);
      assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), false);
      assert.ok(!(await row.innerText()).includes('Up to date'));
      await page.screenshot({ path: join(artifacts, `${view}-admitted-${width}.png`), fullPage: true }); screenshots++;
      // Completion observes the same cached review: old inventory must not win.
      finishSource(state); await notify();
      await page.waitForFunction(() => document.querySelector('.pa-update-source-result')?.textContent.includes('Source switched'));
      assert.ok((await row.innerText()).includes(`2.0.0 · Switched to ${view === 'source_managed' ? 'Local development' : 'GitHub'}`));
      assert.ok(!/1\.0\.0|Not applied|Up to date/.test(await row.innerText()));
      for (const button of await sourceButtons.all()) assert.equal(await button.isEnabled(), false, 'consumed review cannot switch another row');
      await page.screenshot({ path: join(artifacts, `${view}-complete-${width}.png`), fullPage: true }); screenshots++;
      await panel.getByRole('button', { name: 'Check again', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.pa-updates')?.textContent.includes('This review was used'));
      assert.equal(await row.locator('.pa-update-source-action').isEnabled(), true);
    }
    if (['source_switch_refused', 'source_switch_lost_response'].includes(view)) {
      await panel.locator('[data-source-id="google-calendar"] .pa-update-source-action').click();
      await panel.getByRole('button', { name: 'Switch source', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('The switch response was interrupted'));
      const notice = await panel.innerText();
      assert.ok(notice.includes('may have been admitted'));
      assert.ok(notice.includes('Inspect the saved result before confirming another switch'));
      assert.ok(notice.includes('Nothing is retried automatically'));
      assert.ok(!/Could not read the saved result|PRIVATE_SENTINEL|switch failed/i.test(notice));
      const reread = page.waitForResponse(response => response.url().endsWith('/rpc/applicationStatus')); await notify(); await reread;
      await settle(panel);
      assert.equal(await panel.locator('.pa-update-check').count(), 0, 'an old successful read cannot restore green after a lost source response');
      assert.equal(writes.length, 1, 'no automatic source write replay');
      for (const button of await sourceButtons.all()) assert.equal(await button.isEnabled(), false);
      await page.screenshot({ path: join(artifacts, `${view}-interrupted-${width}.png`), fullPage: true }); screenshots++;
      if (view === 'source_switch_lost_response') {
        assert.ok((await panel.innerText()).includes('Switching source…'));
        assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), false);
        finishSource(state); await notify();
        await page.waitForFunction(() => document.querySelector('.pa-update-source-result')?.textContent.includes('Source switched'));
      }
      await panel.getByRole('button', { name: 'Check again', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.pa-updates')?.textContent.includes('The switch response was interrupted'));
      assert.equal(await panel.locator('.pa-update-check').count(), 9);
      await panel.locator('[data-source-id="google-calendar"] .pa-update-source-action').click();
      await panel.getByRole('button', { name: 'Switch source', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pa-update-source-result')?.textContent.includes('Switching source…'));
      assert.deepEqual(writes.map(write => write.method), ['switchSource', 'review', 'switchSource'], 'a new switch needs a new check and explicit confirmation');
    }
    if (view === 'source_pending') {
      assert.ok(text.includes('Switching source'));
      assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), false);
      for (const button of await sourceButtons.all()) assert.equal(await button.isEnabled(), false);
    }
    if (['source_failed_local', 'source_failed_github', 'source_recovery_aborted', 'source_recovery_waiting', 'source_recovery_rpc_refused'].includes(view)) {
      assert.ok(text.includes('Settings and data are kept')); assert.ok(text.includes('folders remain reserved'));
      assert.ok(text.includes(view === 'source_failed_github' ? 'git:https://github.com/mattwynne/pa-bb.git@main --subdirectory plugins/google-calendar' : 'path:$HOME/src/pa-bb/plugins/google-calendar'));
      assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), false);
      const row = panel.locator('[data-source-id="google-calendar"]'); assert.ok(!(await row.innerText()).includes('Up to date'));
      await panel.getByRole('button', { name: 'Check recovery', exact: true }).click();
      if (['source_recovery_waiting', 'source_recovery_rpc_refused'].includes(view)) {
        await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Recovery is not verified yet'));
        const refused = await panel.innerText();
        assert.ok(refused.includes('Nothing was installed or removed by this check'));
        assert.ok(refused.includes('folders remain reserved')); assert.ok(refused.includes('reinstall the intended'));
        assert.ok(!/Could not read the saved result|PRIVATE_SENTINEL/.test(refused));
        const reread = page.waitForResponse(response => response.url().endsWith('/rpc/applicationStatus')); await notify(); await reread; await settle(panel);
        if (view === 'source_recovery_rpc_refused') assert.equal(await panel.locator('.pa-update-check').count(), 0, 'old snapshot cannot restore green after refused recovery');
        assert.equal(writes.length, 1, 'a refused recovery is never automatically retried');
        assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), false);
        await page.screenshot({ path: join(artifacts, `${view}-refused-${width}.png`), fullPage: true }); screenshots++;
        await panel.getByRole('button', { name: 'Check recovery', exact: true }).click();
      }
      await page.waitForFunction(() => !document.querySelector('.pa-updates')?.textContent.includes('Check recovery'));
      assert.deepEqual(writes, Array.from({ length: ['source_recovery_waiting', 'source_recovery_rpc_refused'].includes(view) ? 2 : 1 }, () => ({ method: 'acknowledgeSourceRecovery', input: { jobId: '55555555-5555-4555-8555-555555555555' } })));
      assert.ok((await panel.innerText()).includes(view === 'source_recovery_aborted' ? 'Original source kept' : 'Source switched'));
      assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), true);
      for (const button of await sourceButtons.all()) assert.equal(await button.isEnabled(), false);
      await page.screenshot({ path: join(artifacts, `${view}-checked-${width}.png`), fullPage: true }); screenshots++;
    }
    if (view === 'source_legacy_possible') assert.ok(text.includes('may have been deleted'));
    if (view === 'source_legacy_planned') assert.ok(text.includes('no completed reset is confirmed'));
    if (view === 'source_legacy_deleted') { assert.ok(text.includes('were deleted')); assert.ok(text.includes('Reconnect and reconfigure')); assert.ok(text.includes('folders remain paused')); }
    if (view === 'source_complete_stale') {
      const rowText = await panel.locator('[data-source-id="google-calendar"]').innerText();
      assert.ok(rowText.includes('2.0.0 · Switched to Local development'));
      assert.ok(!/1\.0\.0|1\.1\.0|Not applied|Up to date/.test(rowText));
      for (const name of ['Update PA', 'Apply local changes']) assert.equal(await panel.getByRole('button', { name, exact: true }).isEnabled(), false);
      for (const button of await sourceButtons.all()) assert.equal(await button.isEnabled(), false);
      assert.equal(await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), true);
    }
    if (view === 'local') {
      const button = panel.getByRole('button', { name: 'Apply local changes', exact: true }); await button.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Applied changes'));
      assert.deepEqual(writes.at(-1), { method: 'applyLocal', input: { reviewId } });
    }
    if (view === 'consent') {
      await panel.getByRole('button', { name: 'Update PA', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Update finished'));
      assert.ok((await panel.innerText()).includes('Check again to enable source switching')); assert.equal(writes.at(-1).input.confirmInterruptingThreads, true); assert.deepEqual(writes.at(-1).input.choices, []);
    }
    assert.deepEqual(errors, []); assert.ok(!(await panel.innerText()).includes('PRIVATE_SENTINEL')); await page.close();
  }
  for (const width of [1280, 390]) {
    const reference = await browser.newPage({ viewport: { width, height: 1000 } });
    await reference.goto(host.env.BB_SERVER_URL + '/settings/plugins/google-calendar');
    await reference.locator('.pa-calendar').getByRole('button', { name: 'Refresh status' }).waitFor({ timeout: 60000 });
    await reference.screenshot({ path: join(artifacts, `calendar-reference-${width}.png`) }); await reference.close();
  }
  completed = true; console.log(JSON.stringify({ nativeRenderedBb: host.pkg.version, screenshots, widths: [1280, 390], views, stateViewportCases: views.length * 2, syntheticSourceRpcOnly: true, nativeSourceSwitchProven: false, sourceDialogKeyboardAndScope: true, warningDirectionViewportCases: views.filter(view => ['source_managed', 'source_local'].includes(view)).length * componentIds.length * 2, keyboardFooterAndActions: true, nativeRestartConsent: true, realProgressEvents: true, noAccountWrites: true, artifacts }));
} finally { await browser?.close(); await host.finish(completed); }
