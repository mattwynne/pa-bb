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
import { applicationStatusSchema } from '../core/application-model.ts';
import { componentIds } from '../core/workspace.ts';
const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const host = await createGateHost(process.env.BB_REVIEW_PACKAGE ?? join(source, 'node_modules/bb-app'));
const artifacts = await mkdtemp(join(tmpdir(), 'pa-git-first-ui-'));
let browser, completed = false, screenshots = 0;
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64), reviewId = '11111111-1111-4111-8111-111111111111';
function current() {
  const components = Object.fromEntries(componentIds.map(id => [id, { local: false, upstream: false, working: a, origin: a }]));
  return { checking: false, applying: false, failure: null, job: null, progress: null, offers: { available: false, checkedAt: new Date().toISOString() }, review: {
    id: reviewId, at: new Date().toISOString(), rows: [], localRows: [], workspace: { head: 'a'.repeat(40), originHead: 'a'.repeat(40), dirty: false, ahead: false, behind: false, components },
    inventory: componentIds.map(id => ({ id, installed: '1.0.0', local: 'stock', sourceMode: 'local', state: 'current', prerequisite: null, workspace: components[id], applied: a })),
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
    Object.assign(work, { local: true, working: b }); row.applied = null; state.review.workspace.dirty = true;
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
  if (view === 'progress') { state.checking = true; state.progress = { id: '44444444-4444-4444-8444-444444444444', requested: true, integrations: [], integrationsDone: false, runtime: [], runtimeDone: false, target: null }; }
  if (view === 'consent') { state.review.runtime.runningThreadCount = 2; Object.assign(state.review.runtime.rows[2], { state: 'ready', available: '1.0.1' }); }
  if (view === 'uncertain') {
    state.job = { id: '22222222-2222-4222-8222-222222222222', reviewId, mode: 'local', phase: 'attention', receipts: [{ id: 'icloud', choice: 'install', before: '1.0.0', preview: '1.0.0', actual: null, outcome: 'uncertain' }],
      syncReserved: true, failure: 'interrupted', runtimeReceipts: [], bbIntent: null, selfIntent: null, confirmInterruptingThreads: false };
  }
  return applicationStatusSchema.parse(state);
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
  const views = process.env.BB_REVIEW_VIEWS?.split(',') ?? ['current', 'local', 'incoming', 'both', 'unapplied', 'unconfirmed', 'progress', 'consent', 'source_only', 'failed_check', 'uncertain'];
  for (const view of views) for (const width of [1280, 390]) {
    let state = makeState(view), reviews = 0; const writes = [], errors = [];
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/plugins/pa-updates/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      assert.ok(['status', 'applicationStatus', 'review', 'apply', 'applyLocal', 'resumeSync'].includes(method));
      if (['review', 'apply', 'applyLocal', 'resumeSync'].includes(method)) writes.push({ method, input: route.request().postDataJSON() });
      if (method === 'review') {
        reviews++; if (view === 'failed_check' && reviews === 1) return route.fulfill({ json: { ok: false, error: { code: 'internal', message: 'PRIVATE_SENTINEL' } } });
        state.review.id = '33333333-3333-4333-8333-333333333333';
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
    // BB animates the narrow sidebar shelf after navigation. Wait for geometry,
    // not a guessed delay, before judging or capturing the finished layout.
    await panel.evaluate(async element => {
      let previous = '', stable = 0; const deadline = performance.now() + 5000;
      while (stable < 3) {
        await new Promise(requestAnimationFrame); const box = element.getBoundingClientRect();
        const position = JSON.stringify([box.x, box.y, box.width, box.height]);
        stable = position === previous ? stable + 1 : 0; previous = position;
        if (performance.now() > deadline) throw new Error('BB layout did not settle');
      }
    });
    assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth + 1), true, 'no horizontal overflow or clipped panel');
    await page.screenshot({ path: join(artifacts, `${view}-${width}.png`), fullPage: true }); screenshots++;
    if (await panel.evaluate(element => element.getBoundingClientRect().bottom > innerHeight)) {
      await panel.getByRole('button', { name: 'Check again' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `${view}-${width}-bottom.png`) }); screenshots++;
    }
    if (view === 'local') {
      const button = panel.getByRole('button', { name: 'Apply local changes', exact: true }); await button.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Applied changes'));
      assert.deepEqual(writes.at(-1), { method: 'applyLocal', input: { reviewId } });
    }
    if (view === 'consent') {
      await panel.getByRole('button', { name: 'Update PA', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pa-updates')?.textContent.includes('Update finished'));
      assert.equal(writes.at(-1).input.confirmInterruptingThreads, true); assert.deepEqual(writes.at(-1).input.choices, []);
    }
    assert.deepEqual(errors, []); assert.ok(!(await panel.innerText()).includes('PRIVATE_SENTINEL')); await page.close();
  }
  for (const width of [1280, 390]) {
    const reference = await browser.newPage({ viewport: { width, height: 1000 } });
    await reference.goto(host.env.BB_SERVER_URL + '/settings/plugins/google-calendar');
    await reference.locator('.pa-calendar').getByRole('button', { name: 'Refresh status' }).waitFor({ timeout: 60000 });
    await reference.screenshot({ path: join(artifacts, `calendar-reference-${width}.png`) }); await reference.close();
  }
  completed = true; console.log(JSON.stringify({ nativeRenderedBb: host.pkg.version, screenshots, widths: [1280, 390], views, keyboardFooterAndActions: true, nativeRestartConsent: true, realProgressEvents: true, noAccountWrites: true, artifacts }));
} finally { await browser?.close(); await host.finish(completed); }
