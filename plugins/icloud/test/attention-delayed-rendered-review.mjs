// Only an owned disposable BB0.49 with the generated/fake iCloud backend.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const base = process.env.BB_REVIEW_BASE;
if (!base) throw new Error('Set BB_REVIEW_BASE to an isolated BB instance.');
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? '/tmp/icloud-attention-delayed-rendered';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : {}) });
const failures = [];
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Synthetic boundary did not settle'); }
try {
  for (const width of [1280, 390]) for (const scenario of ['current', 'cleared', 'stronger', 'inline', 'unavailable', 'offline', ...(process.env.BB_REVIEW_CLI ? ['unmount'] : []), 'history'].filter(scenario => !process.env.BB_REVIEW_SCENARIO || scenario === process.env.BB_REVIEW_SCENARIO)) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } });
    const page = await context.newPage(); let restorePlugin = false;
    try {
      let release; let statusUnavailable = false; let statusCalls = 0;
      const claimed = new Set();
      const state = { connected: true, connectionCheck: 'verified', challenge: null, mirrors: [], available: true, prerequisite: null, noteAccessVersion: null, lastSignInCompletedAt: '2026-10-01T00:00:00.000Z', attention: { stage: 'reminder', generation: 'reminder:synthetic', snoozedUntil: null, inlineVisible: false } };
      await context.route('**/api/v1/plugins/icloud/rpc/**', async route => {
        const method = new URL(route.request().url()).pathname.split('/').at(-1);
        const input = route.request().postDataJSON();
        let result = state;
        if (method === 'status') { statusCalls++; if (statusUnavailable) return route.fulfill({ status: 503, json: { ok: false } }); }
        if (method === 'attentionPresence') { if (state.attention) state.attention.inlineVisible = input.visible; result = null; }
        if (method === 'attentionAction') {
          if (input.action === 'claim') { result = !claimed.has(input.generation); claimed.add(input.generation); }
          else {
            await new Promise(resolve => { release = resolve; });
            if (['stronger', 'inline', 'unavailable', 'offline', 'unmount'].includes(scenario)) return route.fulfill({ status: 503, json: { ok: false, error: { message: 'Synthetic snooze failure' } } });
            result = false;
          }
        }
        return route.fulfill({ json: { ok: true, result } });
      });
      await page.goto(base + '/');
      await page.getByRole('button', { name: 'Remind tomorrow', exact: true }).waitFor();
      if (scenario === 'history') {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
        await page.getByText('Show all notifications', { exact: true }).click();
        const center = page.getByTestId('notification-center'); await center.waitFor();
        await until(async () => await page.locator('[data-sonner-toast]').count() === 0);
        const row = center.getByTestId('notification-row').filter({ hasText: 'iCloud sign-in reminder' });
        const link = row.getByRole('link', { name: 'iCloud settings', exact: true }); await link.waitFor({ timeout: 2500 });
        assert.equal(await link.getAttribute('href'), '/plugins/icloud?configure=icloud');
        assert.doesNotMatch(await row.innerText(), /PRIVATE_SENTINEL|password|123456/);
        await page.screenshot({ path: `${artifacts}/history-${width}.png` });
        await link.click();
        await page.locator('.pa-icloud').getByRole('button', { name: 'Reconnect Apple', exact: true }).click();
        await page.getByLabel('Apple password', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Apple password', { exact: true }).getAttribute('type'), 'password');
      } else {
        await page.getByRole('button', { name: 'Remind tomorrow', exact: true }).click(); await until(() => !!release);
        await page.waitForTimeout(600);
        const before = statusCalls;
        if (scenario === 'cleared') state.attention = null;
        if (scenario === 'stronger') state.attention = { stage: 'authentication', generation: 'authentication:1', snoozedUntil: null, inlineVisible: false };
        if (scenario === 'inline') {
          const other = await context.newPage(); await other.goto(base + '/plugins/icloud?configure=icloud');
          await other.locator('.pa-icloud__attention').waitFor();
        }
        if (scenario === 'unavailable') statusUnavailable = true;
        if (scenario === 'offline') await context.setOffline(true);
        if (scenario === 'unmount') {
          execFileSync(process.execPath, [process.env.BB_REVIEW_CLI, 'plugin', 'disable', 'icloud'], { env: { ...process.env, BB_SERVER_URL: base }, stdio: 'pipe' }); restorePlugin = true;
          await page.waitForTimeout(700);
        } else if (scenario === 'stronger') {
          await page.evaluate(() => window.dispatchEvent(new Event('online'))); await until(() => statusCalls > before);
          await page.locator('[data-sonner-toast]').filter({ hasText: 'Sign in to iCloud again' }).waitFor();
        }
        release(); await page.waitForTimeout(700);
        const toast = page.locator('[data-sonner-toast]');
        if (scenario === 'current') await toast.getByText('Could not save the reminder.', { exact: false }).waitFor({ timeout: 2500 });
        else if (scenario === 'stronger') {
          assert.equal(await toast.count(), 1); assert.match(await toast.innerText(), /Sign in to iCloud again/); assert.doesNotMatch(await toast.innerText(), /Could not save|iCloud sign-in reminder/);
        } else assert.equal(await toast.count(), 0, `${scenario} must not recreate a stale toast`);
        await page.screenshot({ path: `${artifacts}/${scenario}-${width}.png` });
      }
      console.log(`PASS delayed attention ${scenario} ${width}`);
    } catch (error) { failures.push(`${scenario} ${width}: ${error.message}`); console.error(`FAIL ${scenario} ${width}: ${error.message}`); }
    finally {
      if (restorePlugin) execFileSync(process.execPath, [process.env.BB_REVIEW_CLI, 'plugin', 'enable', 'icloud'], { env: { ...process.env, BB_SERVER_URL: base }, stdio: 'pipe' });
      await context.close();
    }
  }
} finally { await browser.close(); }
assert.deepEqual(failures, []);
