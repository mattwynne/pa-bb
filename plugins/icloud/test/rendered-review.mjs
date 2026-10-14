// Run against an isolated running BB with this plugin installed, never a real account.
// BB_REVIEW_BASE=http://127.0.0.1:<port> node test/rendered-review.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.BB_REVIEW_BASE;
if (!base) throw new Error('Set BB_REVIEW_BASE to an isolated BB instance.');
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? '/tmp/icloud-rendered-review';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : {}) });
const mirror = { id: 'review-mirror', folder: { id: 'review-folder', name: 'Test Vault', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-10-10T12:00:00.000Z', failure: null, blocker: null, retryPending: false, stale: false, recovering: false, progress: null };
try {
  const statusViews = ['first', 'prerequisite', 'pending', 'empty', 'connected', 'paused', 'running', 'retry-pending', 'repeated-stale', 'source-changed', 'recovering', 'reconnect-needed', 'reconnected-resume', 'multi-reconnected-resume', 'capacity', 'configuration', 'critical', 'legacy-retry', 'initial-block', 'retained', 'error'];
  for (const view of statusViews) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const methods = [];
    const state = { available: view !== 'prerequisite', prerequisite: view === 'prerequisite' ? 'The host needs stock rclone v1.75.2.' : null,
      connected: !['first', 'prerequisite', 'pending', 'reconnect-needed'].includes(view), challenge: view === 'pending' ? 'verification_code' : null,
      mirrors: ['first', 'prerequisite', 'pending', 'empty', 'error'].includes(view) ? [] : [{ ...mirror }] };
    const item = state.mirrors[0];
    if (item) {
      if (view === 'paused') Object.assign(item, { initialized: false, enabled: false, phase: 'paused', lastSuccess: null });
      if (view === 'running') Object.assign(item, { phase: 'running' });
      if (view === 'retry-pending') Object.assign(item, { phase: 'failed', failure: 'sync_failed', retryPending: true, stale: true });
      if (view === 'repeated-stale') Object.assign(item, { phase: 'failed', failure: 'sync_failed', retryPending: true, stale: true, lastSuccess: '2026-10-08T12:00:00.000Z' });
      if (view === 'source-changed') Object.assign(item, { phase: 'failed', failure: 'source_changed', retryPending: true, stale: true });
      if (view === 'recovering') Object.assign(item, { phase: 'running', failure: 'interrupted', recovering: true, stale: true });
      if (['reconnect-needed', 'reconnected-resume', 'multi-reconnected-resume'].includes(view)) Object.assign(item, { phase: 'failed', failure: 'authentication', blocker: 'reconnect', stale: true });
      if (view === 'multi-reconnected-resume') state.mirrors.push({ ...item, id: 'review-second', folder: { ...item.folder, name: 'Other Vault' } });
      if (view === 'capacity') Object.assign(item, { phase: 'failed', failure: 'capacity', blocker: 'capacity', stale: true });
      if (view === 'configuration') Object.assign(item, { phase: 'failed', failure: 'configuration', blocker: 'configuration', stale: true });
      if (view === 'critical') Object.assign(item, { phase: 'failed', failure: 'recovery_required', blocker: 'rebuild', stale: true });
      if (view === 'legacy-retry') Object.assign(item, { phase: 'failed', enabled: false, failure: 'sync_failed', stale: true });
      if (view === 'initial-block') Object.assign(item, { initialized: false, enabled: false, phase: 'failed', lastSuccess: null, failure: 'interrupted', blocker: 'initialization' });
      if (view === 'retained') Object.assign(item, { enabled: false, phase: 'retained', stale: true });
    }
    await page.route('**/api/v1/plugins/icloud/rpc/**', route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      methods.push(method);
      const result = method === 'browse' ? [{ id: 'review-folder', name: 'Test Vault', ancestors: [] }, { id: 'other', name: 'Other Vault', ancestors: [] }] : state;
      return route.fulfill({ json: view === 'error' ? { ok: false, error: { code: 'synthetic_failure', message: 'Controlled review failure' } } : { ok: true, result } });
    });
    await page.goto(base + '/plugins/icloud?configure=icloud');
    const section = page.locator('.pa-icloud'); await section.waitFor();
    await page.waitForFunction(() => [...document.styleSheets].some(sheet => {
      try { return [...sheet.cssRules].some(rule => rule.selectorText === '.pa-icloud__form'); } catch { return false; }
    }));
    await section.getByText(view === 'error' ? 'Connection status unavailable.' : view === 'pending' ? 'Finish connecting' : ['first', 'prerequisite', 'reconnect-needed'].includes(view) ? 'Get started' : 'Connected', { exact: true }).waitFor();
    assert.equal(await section.evaluate(element => element.scrollWidth > element.clientWidth), false);
    if (['first', 'prerequisite', 'pending'].includes(view)) {
      if (view !== 'pending') assert.equal(await section.locator('ol').evaluate(element => getComputedStyle(element).listStyleType), 'decimal');
      const secret = section.getByLabel(view === 'pending' ? 'Verification code' : 'Apple password', { exact: true });
      assert.equal(await secret.getAttribute('type'), 'password');
      await secret.focus(); assert.equal(await secret.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
      if (view === 'prerequisite') assert.equal(await section.getByRole('button', { name: 'Connect account', exact: true }).isDisabled(), true);
    }
    if (view === 'connected') {
      await section.getByText('Sync and file safety', { exact: true }).click();
      await section.getByText(/BB does not create whole-folder backups or provide undo/).waitFor();
      assert.equal(await section.getByText(/1 GiB|30 days|reusing unchanged/).count(), 0);
    }
    if (view === 'connected' || view === 'empty') {
      assert.equal(await section.getByLabel('Apple password', { exact: true }).count(), 0);
      await section.getByRole('button', { name: 'Choose a folder', exact: true }).click();
      if (view === 'connected') {
        await section.getByLabel('Test Vault: Selected', { exact: true }).waitFor();
        assert.equal(await section.getByRole('button', { name: 'Select Test Vault', exact: true }).count(), 0);
      }
      const select = section.getByRole('button', { name: view === 'connected' ? 'Select Other Vault' : 'Select Test Vault', exact: true }); await select.waitFor();
      await page.keyboard.press('Tab'); await select.focus(); assert.equal(await select.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      assert.equal(await section.evaluate(element => element.scrollWidth > element.clientWidth), false);
    }
    if (view === 'paused') {
      const enable = section.getByRole('button', { name: 'Enable sync for Test Vault', exact: true }); await enable.waitFor();
      const dialogPromise = page.waitForEvent('dialog'); const click = enable.click(); const dialog = await dialogPromise;
      assert.match(dialog.message(), /two-way sync/); assert.match(dialog.message(), /deletions/); assert.match(dialog.message(), /does not back up/); await dialog.dismiss(); await click;
    }
    if (['retry-pending', 'repeated-stale', 'source-changed'].includes(view)) {
      await section.getByText('Retry pending', { exact: true }).waitFor();
      assert.equal(await section.getByRole('alert').count(), 0);
      await section.getByRole('status').filter({ hasText: /previous attempt|last sync/ }).waitFor();
      const pause = section.getByRole('button', { name: 'Pause Test Vault', exact: true }); await pause.focus();
      assert.equal(await pause.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      assert.equal(await section.getByRole('button', { name: 'Create fresh mirror' }).count(), 0);
    }
    if (view === 'recovering') {
      await section.getByText('Retrying…', { exact: true }).waitFor();
      await section.getByRole('status').filter({ hasText: /Retrying with rclone’s normal checks/ }).waitFor();
      assert.equal(await section.getByRole('alert').count(), 0);
      assert.equal(await section.getByRole('button', { name: /Pause|Retry|Create fresh mirror/ }).count(), 0);
    }
    if (view === 'reconnect-needed') {
      await section.getByText('Reconnect required', { exact: true }).waitFor();
      assert.equal(await section.getByRole('button', { name: 'Resume Test Vault', exact: true }).count(), 0);
    }
    if (view === 'reconnected-resume') {
      await section.getByText('Resume required', { exact: true }).waitFor();
      await section.getByText(/Apple is connected again/).waitFor();
      assert.equal(await section.getByText('Reconnect required', { exact: true }).count(), 0);
      await section.getByText('Recovery steps', { exact: true }).click();
      const resume = section.getByRole('button', { name: 'Resume Test Vault', exact: true }); await page.keyboard.press('Tab'); await resume.focus();
      assert.equal(await resume.evaluate(element => element === document.activeElement), true);
      assert.equal(await resume.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      assert.equal(await section.getByRole('button', { name: 'Create fresh mirror' }).count(), 0);
    }
    if (view === 'multi-reconnected-resume') {
      assert.equal(await section.getByText('Resume required', { exact: true }).count(), 2);
      const steps = section.getByText('Recovery steps', { exact: true });
      for (let i = 0; i < 2; i++) await steps.nth(i).click();
      for (const folder of ['Test Vault', 'Other Vault']) {
        const resume = section.getByRole('button', { name: `Resume ${folder}`, exact: true }); await page.keyboard.press('Tab'); await resume.focus();
        assert.equal(await resume.evaluate(element => element === document.activeElement), true);
        assert.equal(await resume.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      }
      assert.equal(await section.getByRole('button', { name: /Pause|Create fresh mirror/ }).count(), 0);
    }
    if (['capacity', 'configuration'].includes(view)) {
      await section.getByText('Recovery steps', { exact: true }).click();
      await section.getByText(/Fix .* first\. Ask the host operator if needed, then Retry\./).waitFor();
      const retry = section.getByRole('button', { name: 'Retry Test Vault', exact: true }); await page.keyboard.press('Tab'); await retry.focus();
      assert.equal(await retry.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      assert.equal(await section.getByRole('button', { name: 'Create fresh mirror' }).count(), 0);
      await retry.click(); await section.getByText(view === 'capacity' ? 'Storage blocked' : 'Configuration blocked', { exact: true }).waitFor();
      assert.equal(methods.includes('retry'), true);
      assert.equal(await section.getByText(/Sync resumed|Initial preparation finished|Check the new mirror/).count(), 0);
      await page.keyboard.press('Tab'); await retry.focus();
    }
    if (view === 'critical') {
      await section.getByRole('alert').getByText(/This mirror is stopped for recovery review/).waitFor();
      assert.equal(await section.getByText(/Rclone cannot safely continue/).count(), 0);
    }
    if (['critical', 'initial-block'].includes(view)) {
      await section.getByText('Recovery steps', { exact: true }).click();
      const fresh = section.getByRole('button', { name: 'Create fresh mirror' }); await page.keyboard.press('Tab'); await fresh.focus();
      assert.equal(await fresh.evaluate(element => element === document.activeElement), true);
      assert.equal(await fresh.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      const dialogPromise = page.waitForEvent('dialog'); const click = fresh.click(); const dialog = await dialogPromise;
      assert.match(dialog.message(), /not merged or uploaded/); await dialog.dismiss(); await click;
    }
    if (view === 'legacy-retry') {
      const retry = section.getByRole('button', { name: 'Retry Test Vault', exact: true }); await retry.focus();
      assert.equal(await retry.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      assert.equal(await section.getByText(/does not force resync/).count(), 1);
      await retry.click(); await section.getByText('Sync unsuccessful', { exact: true }).waitFor();
      assert.equal(methods.includes('retry'), true);
      assert.equal(await section.getByText(/Sync resumed|Initial preparation finished|Check the new mirror/).count(), 0);
      await page.keyboard.press('Tab'); await retry.focus();
    }
    if (view === 'retained') assert.equal(await section.getByRole('button', { name: 'Resume Test Vault' }).count(), 0);
    await page.screenshot({ path: `${artifacts}/${view}-${width}.png` });
    console.log(`${view} ${width}: rendered in BB, no section overflow, relevant controls checked`);
    await page.close();
  }
  for (const view of ['nested', 'empty-folder', 'overlap', 'long-names', 'pending-browser', 'browse-error', 'late-close']) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const state = { available: true, prerequisite: null, connected: true, challenge: null, mirrors: view === 'overlap' ? [{ ...mirror, folder: { id: 'vault', name: 'Test Vault', ancestors: ['notes'] } }] : [] };
    const notes = { id: 'notes', name: view === 'long-names' ? 'Notes with a very long folder name that must stay readable on a narrow phone screen' : 'Notes', ancestors: [] };
    const vault = { id: 'vault', name: 'Test Vault', ancestors: ['notes'] };
    let release; let nestedCalls = 0;
    await page.route('**/api/v1/plugins/icloud/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      const payload = route.request().postDataJSON(); const input = payload?.input ?? payload;
      let result = state;
      if (method === 'browse') {
        const parent = input?.parent;
        if (parent) {
          nestedCalls++;
          if (['pending-browser', 'late-close'].includes(view)) await new Promise(resolve => { release = resolve; });
          if (view === 'browse-error') return route.fulfill({ json: { ok: false, error: { code: 'synthetic_failure', message: 'Controlled browse failure' } } });
        }
        result = !parent ? [notes] : parent === 'notes' ? view === 'empty-folder' ? [] : [vault] : [{ id: 'child', name: 'Child', ancestors: ['notes', 'vault'] }];
      }
      if (method === 'select') state.mirrors.push({ ...mirror, folder: input.folderId === 'notes' ? notes : vault, initialized: false, enabled: false, phase: 'paused', lastSuccess: null });
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.goto(base + '/plugins/icloud?configure=icloud'); const section = page.locator('.pa-icloud');
    await section.getByRole('button', { name: 'Choose a folder', exact: true }).click();
    const picker = section.getByLabel('iCloud folder browser', { exact: true }); await picker.waitFor();
    await page.waitForFunction(() => [...document.styleSheets].some(sheet => { try { return [...sheet.cssRules].some(rule => rule.selectorText === '.pa-icloud__folder-open'); } catch { return false; } }));
    const open = picker.getByRole('button', { name: `Open ${notes.name}`, exact: true });
    await page.keyboard.press('Tab'); await open.focus(); assert.equal(await open.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    assert.ok(await open.locator('svg').count() >= 2);
    await page.keyboard.press('Enter');
    if (['pending-browser', 'late-close'].includes(view)) {
      await picker.getByText('Loading folders…', { exact: true }).waitFor(); assert.equal(await picker.getAttribute('aria-busy'), 'true');
      assert.equal(await open.isDisabled(), true);
      if (view === 'late-close') await picker.getByRole('button', { name: 'Close folder browser', exact: true }).click();
      assert.equal(typeof release, 'function'); release();
    }
    if (view === 'late-close') {
      await section.getByRole('button', { name: 'Choose a folder', exact: true }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.pa-icloud button')].some(button => button.textContent === 'Choose a folder' && !button.disabled));
      assert.equal(await picker.count(), 0);
    } else if (view === 'browse-error') {
      await section.getByRole('alert').getByText(/Could not list iCloud folders/).waitFor();
      assert.equal(await picker.getByRole('button', { name: `Open ${notes.name}`, exact: true }).isDisabled(), false);
    } else {
      await picker.getByRole('button', { name: 'Back to parent folder', exact: true }).waitFor();
      await picker.locator('[aria-current="location"]').getByText(notes.name, { exact: true }).waitFor();
      assert.equal(nestedCalls, 1);
      if (view === 'empty-folder') await picker.getByText('No child folders. You can select this folder below.', { exact: true }).waitFor();
      if (view === 'overlap') {
        await picker.getByLabel('Test Vault: Selected', { exact: true }).waitFor();
        assert.equal(await picker.getByRole('button', { name: 'Select Test Vault', exact: true }).count(), 0);
        await picker.getByRole('button', { name: 'Open Test Vault', exact: true }).click();
        await picker.getByLabel('Child: Inside a selected folder', { exact: true }).waitFor();
        await picker.getByRole('button', { name: 'Back to parent folder', exact: true }).click();
        await picker.getByRole('button', { name: 'Back to parent folder', exact: true }).click();
        await picker.getByLabel(`${notes.name}: Contains a selected folder`, { exact: true }).waitFor();
      } else {
        const current = picker.getByRole('button', { name: `Select current folder ${notes.name}`, exact: true }); await current.waitFor();
        if (view === 'nested') {
          await current.click(); await picker.getByLabel(`${notes.name}: Selected`, { exact: true }).waitFor();
          await picker.getByRole('button', { name: 'iCloud Drive', exact: true }).click();
          await picker.getByLabel(`${notes.name}: Selected`, { exact: true }).waitFor();
        }
      }
      assert.equal(await picker.evaluate(element => element.scrollWidth > element.clientWidth), false);
      assert.equal(await picker.evaluate(element => [...element.querySelectorAll('button')].every(button => button.getBoundingClientRect().right <= window.innerWidth)), true);
    }
    await page.screenshot({ path: `${artifacts}/${view}-${width}.png` });
    console.log(`${view} ${width}: folder icons, navigation, selection state and layout checked`);
    await page.close();
  }
  const progressCases = [
    { key: 'checking', stage: 'checking', percent: null },
    { key: 'transfer', stage: 'transferring', bytes: 1024, totalBytes: 4096, files: 1, totalFiles: 4, percent: 25 },
    { key: 'zero-byte-files', stage: 'transferring', files: 2, totalFiles: 4, percent: 50 },
    { key: 'unknown-total', stage: 'transferring', bytes: 4096, files: 1, percent: null },
    { key: 'all-transferred', stage: 'transferring', bytes: 4096, totalBytes: 4096, files: 4, totalFiles: 4, percent: 100 },
    { key: 'finishing', stage: 'verifying', percent: null },
    { key: 'growing-total', stage: 'transferring', bytes: 1024, totalBytes: 4096, files: 1, totalFiles: 4, percent: 25 },
    { key: 'progress-success', stage: 'transferring', bytes: 1024, totalBytes: 4096, files: 1, totalFiles: 4, percent: 25 },
    { key: 'progress-failure', stage: 'transferring', bytes: 1024, totalBytes: 4096, files: 1, totalFiles: 4, percent: 25 },
  ];
  for (const fixture of progressCases) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const progress = { stage: fixture.stage, bytes: fixture.bytes ?? 0, totalBytes: fixture.totalBytes ?? null, files: fixture.files ?? 0, totalFiles: fixture.totalFiles ?? null };
    const state = { available: true, prerequisite: null, connected: true, challenge: null, mirrors: [{ ...mirror, phase: 'running', progress }] };
    let calls = 0;
    await page.route('**/api/v1/plugins/icloud/rpc/**', route => { calls++; return route.fulfill({ json: { ok: true, result: state } }); });
    await page.goto(base + '/plugins/icloud?configure=icloud'); const section = page.locator('.pa-icloud');
    const bar = section.getByRole('progressbar'); await bar.waitFor();
    await page.waitForFunction(() => document.querySelector('.pa-icloud__progress-track')?.clientHeight > 0);
    assert.equal(await bar.getAttribute('aria-valuenow'), fixture.percent === null ? null : String(fixture.percent));
    assert.equal(await section.getByText('Last successful sync:', { exact: false }).textContent(), `Last successful sync: ${await page.evaluate(value => new Date(value).toLocaleString(), mirror.lastSuccess)}`);
    assert.equal(await section.getByRole('button', { name: 'Pause Test Vault', exact: true }).count(), 0);
    await section.getByText('Sync controls are available when this run finishes.', { exact: true }).waitFor();
    assert.equal(await section.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.keyboard.press('Tab'); const focus = section.getByRole('button', { name: 'Reconnect', exact: true }); await focus.focus();
    assert.equal(await focus.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    if (fixture.percent === null) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await section.locator('.pa-icloud__progress-fill').evaluate(element => getComputedStyle(element).animationName), 'none');
    }
    if (fixture.key === 'all-transferred') await section.getByText('Transfers complete. Waiting for sync checks.', { exact: true }).waitFor();
    if (fixture.key === 'growing-total') {
      state.mirrors[0].progress = { ...progress, totalBytes: 8192 };
      await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '12');
      assert.ok(calls >= 2);
    }
    if (fixture.key === 'progress-success' || fixture.key === 'progress-failure') {
      state.mirrors[0].phase = fixture.key === 'progress-success' ? 'ready' : 'failed'; state.mirrors[0].progress = null;
      state.mirrors[0].enabled = fixture.key === 'progress-success'; state.mirrors[0].failure = fixture.key === 'progress-failure' ? 'interrupted' : null;
      if (fixture.key === 'progress-success') state.mirrors[0].lastSuccess = '2026-10-10T06:00:00.000Z';
      await bar.waitFor({ state: 'hidden' });
      if (fixture.key === 'progress-failure') await section.getByRole('alert').waitFor();
    }
    await page.screenshot({ path: `${artifacts}/${fixture.key}-${width}.png` });
    console.log(`${fixture.key} ${width}: visible progress, safe totals, timestamp, focus and lifecycle checked`);
    await page.close();
  }
} finally { await browser.close(); }
