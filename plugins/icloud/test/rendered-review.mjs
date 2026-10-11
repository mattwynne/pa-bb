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
const mirror = { id: 'review-mirror', folder: { id: 'review-folder', name: 'Test Vault', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-10-10T12:00:00.000Z', failure: null };
try {
  for (const view of ['first', 'prerequisite', 'pending', 'empty', 'connected', 'paused', 'running', 'failed', 'retained', 'error']) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const state = { available: view !== 'prerequisite', prerequisite: view === 'prerequisite' ? 'The host needs stock rclone v1.75.2.' : null,
      connected: !['first', 'prerequisite', 'pending'].includes(view), challenge: view === 'pending' ? 'verification_code' : null,
      mirrors: ['first', 'prerequisite', 'pending', 'empty', 'error'].includes(view) ? [] : [{ ...mirror, phase: view === 'connected' ? 'ready' : view, enabled: ['connected', 'running'].includes(view), failure: view === 'failed' ? 'capacity' : null }] };
    await page.route('**/api/v1/plugins/icloud/rpc/**', route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1);
      const result = method === 'browse' ? [{ id: 'review-folder', name: 'Test Vault', ancestors: [] }, { id: 'other', name: 'Other Vault', ancestors: [] }] : state;
      return route.fulfill({ json: view === 'error' ? { ok: false, error: { code: 'synthetic_failure', message: 'Controlled review failure' } } : { ok: true, result } });
    });
    await page.goto(base + '/plugins/icloud?configure=icloud');
    const section = page.locator('.pa-icloud'); await section.waitFor();
    await page.waitForFunction(() => [...document.styleSheets].some(sheet => {
      try { return [...sheet.cssRules].some(rule => rule.selectorText === '.pa-icloud__form'); } catch { return false; }
    }));
    await section.getByText(view === 'error' ? 'Connection status unavailable.' : view === 'pending' ? 'Finish connecting' : view === 'first' || view === 'prerequisite' ? 'Get started' : 'Connected', { exact: true }).waitFor();
    assert.equal(await section.evaluate(element => element.scrollWidth > element.clientWidth), false);
    if (['first', 'prerequisite', 'pending'].includes(view)) {
      if (view !== 'pending') assert.equal(await section.locator('ol').evaluate(element => getComputedStyle(element).listStyleType), 'decimal');
      const secret = section.getByLabel(view === 'pending' ? 'Verification code' : 'Apple password', { exact: true });
      assert.equal(await secret.getAttribute('type'), 'password');
      await secret.focus(); assert.equal(await secret.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
      if (view === 'prerequisite') assert.equal(await section.getByRole('button', { name: 'Connect account', exact: true }).isDisabled(), true);
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
      const enableState = { ...state, mirrors: [{ ...mirror, initialized: false, enabled: false, phase: 'paused' }] };
      await page.route('**/api/v1/plugins/icloud/rpc/status', route => route.fulfill({ json: { ok: true, result: enableState } }));
      await section.getByRole('button', { name: 'Refresh status', exact: true }).click();
      const enable = section.getByRole('button', { name: 'Enable sync for Test Vault', exact: true }); await enable.waitFor();
      const dialogPromise = page.waitForEvent('dialog'); const click = enable.click(); const dialog = await dialogPromise;
      assert.match(dialog.message(), /two-way sync/); assert.match(dialog.message(), /deletions/); await dialog.dismiss(); await click;
    }
    if (view === 'failed') {
      await section.getByText('Recovery steps', { exact: true }).click();
      const dialogPromise = page.waitForEvent('dialog'); const click = section.getByRole('button', { name: 'Create fresh mirror' }).click(); const dialog = await dialogPromise;
      assert.match(dialog.message(), /not merged or uploaded/); await dialog.dismiss(); await click;
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
    { key: 'cloud-backup', stage: 'backing_up_cloud', bytes: 3 * 1024 * 1024, totalBytes: 4 * 1024 * 1024, files: 10, totalFiles: 20, percent: 75 },
    { key: 'local-backup', stage: 'backing_up_local', bytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024, files: 5, totalFiles: 10, percent: 50 },
    { key: 'save-recovery', stage: 'saving_recovery', files: 7, totalFiles: 10, percent: 70 },
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
    assert.equal(await section.getByRole('button', { name: 'Pause Test Vault', exact: true }).isDisabled(), true);
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
