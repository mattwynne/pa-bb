// Synthetic RPC views in a real isolated BB settings host; no Apple/cloud writes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.BB_REVIEW_BASE;
if (!base) throw new Error('Set BB_REVIEW_BASE to an isolated BB instance.');
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? '/tmp/obsidian-rendered-review';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : {}) });
const source = id => ({ id, name: 'Launch', initialized: true, enabled: true, cloudConnected: true, phase: 'ready', lastSuccess: '2026-10-10T12:00:00Z', failure: null, local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } });
const setups = { icloud_error: 'Open iCloud settings and check its startup status.', apple_disconnected: 'Apple is disconnected; sound local notes remain accessible but cloud delivery is stopped.', missing: 'Install iCloud from Plugins, then open its settings.', disabled: 'Enable iCloud in Plugins.', starting: 'Open iCloud settings and check its startup status.', incompatible: 'Update iCloud and Obsidian together for coordinated note access v2. No filesystem fallback is available.', host_prerequisite: 'Ask the operator to check the host requirements shown in iCloud settings.', apple_verification: 'Finish Apple verification in iCloud settings; sound local notes remain accessible.', no_folder: 'Choose a vault folder in iCloud settings.', sync_disabled: 'Enable sync for the selected folder in iCloud settings and finish initial sync.', initial_sync_running: 'Wait for initial sync to finish in iCloud settings.', initial_sync_failed: 'Inspect the initial-sync failure in iCloud settings.', check_failed: 'Could not check iCloud. Keep your settings and choose Check again.' };
try {
  for (const view of ['first', 'eligible', 'connected', 'multiple', 'paused', 'running', 'removed', 'recovery', 'local_blocked', 'unconfirmed', 'error', 'search_missing', 'search_unsupported', 'search_mismatch', 'search_recovered', ...Object.keys(setups)]) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    let dialogs = 0; page.on('dialog', dialog => { dialogs++; void dialog.dismiss(); });
    const state = { search: { version: 1, available: true, reason: null }, revision: 0, conflict: null, conflictFailure: null, configurationUnconfirmed: false, setup: setups[view] ? view : 'ready', nextAction: setups[view] ?? null, vaults: [], eligible: [], receipts: [], receiptFailures: [], uncertainOperations: [], uncertainOperationCount: 0, uncertainOperationsIncomplete: false, evidenceOnly: true };
    if (['eligible', 'connected', 'multiple', 'running'].includes(view)) state.eligible = [source('two')];
    if (['connected', 'multiple', 'paused', 'running', 'removed', 'check_failed'].includes(view)) state.vaults = [{ vaultId: 'one', name: 'Launch', source: source('one') }];
    if (view.startsWith('search_')) { state.vaults = [{ vaultId: 'one', name: 'Launch', source: source('one') }]; state.search = { version: 1, available: false, reason: view === 'search_missing' ? 'missing_executable' : view === 'search_unsupported' ? 'unsupported_version' : 'unavailable' }; }
    if (view === 'multiple') { state.vaults.push({ vaultId: 'two', name: 'Launch', source: source('two') }); state.eligible = []; }
    if (view === 'recovery') { state.vaults = [{ vaultId: 'one', name: 'Launch', source: source('one') }]; state.uncertainOperations = [{ operationId: '12345678-1234-7123-8123-123456789abc', vaultId: 'one', path: 'Conflict.md', at: '2026-10-10T12:00:00Z', kind: 'resolution' }]; state.uncertainOperationCount = 1; }
    if (view === 'local_blocked' || view === 'unconfirmed') { state.vaults = [{ vaultId: 'one', name: 'Launch', source: source('one') }]; if (view === 'local_blocked') state.vaults[0].source.local = { available: false, reason: 'recovery_required', pendingAgeMs: null, applicationBlocker: null }; else state.configurationUnconfirmed = true; }
    if (view === 'paused') Object.assign(state.vaults[0].source, { enabled: false, phase: 'paused' });
    if (view === 'running') { state.vaults[0].source.phase = 'running'; state.eligible[0].phase = 'running'; }
    if (view === 'removed' || view === 'check_failed') state.vaults[0].source = null;
    const methods = [];
    await page.route('**/api/v1/plugins/obsidian/rpc/**', route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1); methods.push(method);
      const input = route.request().postDataJSON();
      if (view === 'search_recovered' && method === 'status' && methods.filter(m => m === 'status').length > 1) state.search = { version: 1, available: true, reason: null };
      if (method === 'connect') { const item = state.eligible.find(s => s.id === input.vaultId); assert.ok(item); state.vaults.push({ vaultId: item.id, source: item }); state.eligible = state.eligible.filter(s => s.id !== item.id); state.revision++; }
      if (method === 'remove') { state.vaults = state.vaults.filter(v => v.vaultId !== input.vaultId); state.revision++; }
      return route.fulfill({ json: view === 'error' ? { ok: false, error: { code: 'synthetic', message: 'Controlled review failure' } } : { ok: true, result: state } });
    });
    await page.goto(base + '/plugins/obsidian?configure=obsidian');
    const section = page.locator('.pa-obsidian'); await section.waitFor();
    await section.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.pa-obsidian')?.textContent.includes('Checking vaults…'));
    await page.waitForFunction(() => [...document.styleSheets].some(sheet => { try { return [...sheet.cssRules].some(rule => rule.selectorText === '.pa-obsidian'); } catch { return false; } }));
    assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await section.getByText(/read.only|approve|permission profile/i).count(), 0);
    if (['first', 'eligible', 'missing'].includes(view)) await section.getByText('Connect a vault so BB can read and edit all its notes. Changes are sent back through iCloud.', { exact: true }).waitFor();
    if (view === 'connected' || view === 'multiple') assert.equal(await section.locator('ol').count(), 0);
    if (['first', 'eligible'].includes(view)) assert.equal(await section.locator('ol').evaluate(el => getComputedStyle(el).listStyleType), 'decimal');
    if (view === 'eligible' || view === 'connected') {
      await section.getByRole('button', { name: 'Add vault', exact: true }).click();
      const connect = section.getByRole('button', { name: /Connect Launch/, exact: false }); await connect.waitFor();
      await page.keyboard.press('Tab'); await connect.focus(); assert.equal(await connect.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      await page.keyboard.press('Enter'); await section.getByText('Vault connected.', { exact: true }).waitFor(); assert.ok(methods.includes('connect'));
    }
    if (view === 'multiple') { assert.equal(await section.getByText('Launch', { exact: true }).count(), 2); await page.screenshot({ path: `${artifacts}/multiple-connected-${width}.png` }); await section.getByRole('button', { name: 'Remove Launch · one', exact: true }).click(); await section.getByText('Vault removed. Notes and iCloud sync are unchanged.', { exact: true }).waitFor(); assert.equal(await section.getByRole('button', { name: 'Remove Launch · one', exact: true }).count(), 0); }
    if (view === 'removed') await section.getByText('Local access unverified · check iCloud settings', { exact: true }).waitFor();
    if (view === 'paused') await section.getByText('Local notes available · cloud paused', { exact: true }).waitFor();
    if (view === 'local_blocked') await section.getByText(/Local notes unavailable/).waitFor();
    if (view === 'unconfirmed') await section.getByText(/not been confirmed by iCloud/).waitFor();
    if (view === 'recovery') await section.getByText(/need exact receipt inspection/).waitFor();
    if (view === 'running') {
      await section.getByRole('button', { name: 'Add vault' }).click();
      await section.getByText('Local notes available · iCloud syncing', { exact: true }).waitFor();
      const connect = section.getByRole('button', { name: 'Connect Launch' }); await connect.waitFor();
      assert.equal(await connect.isEnabled(), true);
      assert.equal(await section.getByText(/wait for note tools/i).count(), 0);
      await connect.click(); await section.getByText('Vault connected.', { exact: true }).waitFor();
    }
    if (view.startsWith('search_')) {
      await section.getByText(/Vault search is unavailable/).waitFor();
      assert.equal(await section.getByRole('button', { name: 'Remove Launch', exact: true }).count(), 1);
      assert.equal(await section.getByRole('link', { name: 'search requirements', exact: true }).count(), 1);
      if (view === 'search_recovered') { await section.getByRole('button', { name: 'Check again', exact: true }).click(); await section.getByText(/Vault search is unavailable/).waitFor({ state: 'hidden' }); }
    }
    if (setups[view]) await section.getByText(setups[view], { exact: true }).waitFor();
    const check = section.getByRole('button', { name: 'Check again', exact: true }); await page.keyboard.press('Tab'); await check.focus(); assert.equal(await check.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    assert.equal(dialogs, 0); assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${artifacts}/${view}-${width}.png` }); console.log(`${view} ${width}: rendered, keyboard, no overflow or confirmations`); await page.close();
  }
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const first = { search: { version: 1, available: true, reason: null }, revision: 1, conflict: null, conflictFailure: null, configurationUnconfirmed: false, setup: 'ready', nextAction: null, vaults: [{ vaultId: 'one', name: 'Launch', source: source('one') }], eligible: [], receipts: [], receiptFailures: [], uncertainOperations: [], uncertainOperationCount: 0, uncertainOperationsIncomplete: false, evidenceOnly: true };
    let checks = 0; let release; let entered; let current = first;
    const waiting = new Promise(resolve => { entered = resolve; });
    await page.route('**/api/v1/plugins/obsidian/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      const snapshot = current;
      if (method === 'status' && ++checks === 2) { entered(); await new Promise(resolve => { release = resolve; }); }
      if (method === 'remove') current = { ...first, revision: 2, vaults: [] };
      return route.fulfill({ json: { ok: true, result: method === 'remove' ? current : snapshot } });
    });
    await page.goto(base + '/plugins/obsidian?configure=obsidian'); const section = page.locator('.pa-obsidian');
    await section.getByRole('button', { name: 'Remove Launch', exact: true }).waitFor();
    await section.getByRole('button', { name: 'Check again', exact: true }).click(); await waiting;
    await section.getByRole('button', { name: 'Remove Launch', exact: true }).click(); await section.getByText('Vault removed. Notes and iCloud sync are unchanged.', { exact: true }).waitFor();
    const late = page.waitForResponse(response => response.url().endsWith('/rpc/status')); release(); await late; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await section.getByRole('button', { name: 'Remove Launch', exact: true }).count(), 0);
    await page.reload(); await section.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.pa-obsidian')?.textContent.includes('Checking vaults…'));
    assert.equal(await section.getByRole('button', { name: 'Remove Launch', exact: true }).count(), 0);
    await section.getByRole('link', { name: 'iCloud settings', exact: true }).click();
    await page.waitForURL('**/plugins/icloud?configure=icloud');
    // The target plugin can fail its platform prerequisite in a UI-only fixture.
    // Assert host navigation here, not a mounted iCloud runtime/settings view.
    console.log(`late status/removal and host navigation to iCloud route ${width}: passed`); await page.close();
  }
} finally { await browser.close(); }
