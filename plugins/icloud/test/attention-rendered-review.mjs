// Run only against a disposable stock BB 0.49 with synthetic iCloud backend.
// BB_REVIEW_BASE=... BB_REVIEW_CHROME=... node test/attention-rendered-review.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.BB_REVIEW_BASE;
if (!base) throw new Error('Set BB_REVIEW_BASE to an isolated BB instance.');
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? '/tmp/icloud-attention-rendered';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.BB_REVIEW_CHROME ? { executablePath: process.env.BB_REVIEW_CHROME } : {}) });
const mirror = (id, extra = {}) => ({ id, folder: { id, name: id === 'critical' ? 'Review Vault' : 'Paused Vault', ancestors: [] }, initialized: true, enabled: false, phase: 'paused', lastSuccess: null, failure: null, blocker: null, retryPending: false, recovering: false, progress: null, local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null }, ...extra });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } });
    const page = await context.newPage();
    let claimed = false; let unavailable = false; let snoozeFails = false;
    const methods = []; const forms = [];
    const state = { connected: true, challenge: null, available: true, prerequisite: null, mirrorFileAccessVersion: null,
      lastSignInCompletedAt: '2026-10-01T00:00:00.000Z', attention: { stage: 'reminder', generation: 'reminder:synthetic', snoozedUntil: null },
      mirrors: [mirror('paused'), mirror('critical', { phase: 'failed', enabled: true, failure: 'recovery_required', blocker: 'rebuild', local: { available: false, reason: 'recovery_required', pendingAgeMs: null, applicationBlocker: 'application_uncertain' } })] };
    await context.route('**/api/v1/plugins/icloud/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1); methods.push(method);
      const input = route.request().postDataJSON();
      if (unavailable || (method === 'attentionAction' && input.action === 'snooze' && snoozeFails)) return route.fulfill({ status: 503, json: { ok: false, error: { message: 'Controlled failure' } } });
      let result = state;
      if (method === 'attentionPresence') result = null;
      if (method === 'attentionAction') {
        if (input.action === 'claim') { result = !claimed; claimed = true; }
        else { result = true; state.attention.snoozedUntil = '2099-01-01T00:00:00.000Z'; }
      }
      if (method === 'pause') state.mirrors.find(m => m.id === input.id).enabled = false;
      // Continuation assessment intentionally remains fenced: status is not success.
      return route.fulfill({ json: { ok: true, result } });
    });
    await context.route('**/api/v1/plugins/icloud/http/**', async route => {
      const step = new URL(route.request().url()).pathname.split('/').at(-1); forms.push(step);
      assert.equal(route.request().method(), 'POST');
      if (step === 'connect') { state.connected = false; state.challenge = 'verification_code'; }
      else { state.connected = true; state.challenge = null; state.attention = null; state.lastSignInCompletedAt = '2026-11-15T12:00:00.000Z'; }
      return route.fulfill({ headers: { 'Cache-Control': 'no-store' }, json: state });
    });
    await page.goto(base + '/');
    await page.getByRole('button', { name: 'Open iCloud settings', exact: true }).waitFor();
    const nativeToast = page.locator('[data-sonner-toast]').filter({ hasText: 'iCloud sign-in reminder' });
    assert.equal(await nativeToast.count(), 1);
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-sonner-toast]')), false);
    assert.equal(await nativeToast.evaluate(e => e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().left >= 0), true);
    await page.screenshot({ path: `${artifacts}/toast-${width}.png` });
    const other = await context.newPage(); await other.goto(base + '/'); await other.waitForTimeout(1300);
    assert.equal(await other.locator('[data-sonner-toast]').count(), 0); await other.close();
    await page.getByRole('button', { name: 'Open iCloud settings', exact: true }).focus(); await page.keyboard.press('Enter');
    const section = page.locator('.pa-icloud'); await section.waitFor();
    await section.getByRole('button', { name: 'Reconnect Apple', exact: true }).waitFor();
    assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
    snoozeFails = true;
    await section.getByRole('button', { name: 'Remind tomorrow', exact: true }).click();
    await section.getByRole('alert').filter({ hasText: 'It has not been snoozed' }).waitFor(); snoozeFails = false;
    await section.getByRole('button', { name: 'Reconnect Apple', exact: true }).click();
    await section.getByLabel('Apple account email', { exact: true }).fill('synthetic@example.test');
    const password = section.getByLabel('Apple password', { exact: true }); assert.equal(await password.getAttribute('type'), 'password');
    await password.fill('PRIVATE_PASSWORD_SENTINEL'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Connect account');
    await page.keyboard.press('Enter'); await section.getByLabel('Verification code', { exact: true }).waitFor();
    assert.equal(await section.getByLabel('Verification code', { exact: true }).getAttribute('type'), 'password');
    await section.getByLabel('Verification code', { exact: true }).fill('123456');
    await page.screenshot({ path: `${artifacts}/challenge-${width}.png` });
    await section.getByRole('button', { name: 'Verify code', exact: true }).click();
    await section.getByRole('status').filter({ hasText: 'No sync was started' }).waitFor();
    assert.deepEqual(forms, ['connect', 'challenge']);
    assert.equal(state.mirrors[0].enabled, false); assert.equal(state.mirrors[1].blocker, 'rebuild');
    assert.equal(methods.includes('enable') || methods.includes('retry'), false);
    assert.equal(await section.getByLabel('Apple password', { exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_PASSWORD_SENTINEL|123456/);
    await page.screenshot({ path: `${artifacts}/verified-success-${width}.png` });
    const continuation = section.getByRole('button', { name: 'Continue interrupted sync for Review Vault', exact: true });
    await page.keyboard.press('Tab'); await continuation.focus(); assert.equal(await continuation.evaluate(e => getComputedStyle(e).outlineStyle), 'solid'); await page.keyboard.press('Enter');
    await section.getByRole('status').filter({ hasText: 'Continuation did not complete' }).waitFor();
    await section.getByRole('button', { name: 'Pause scheduling for Review Vault', exact: true }).click();
    assert.equal(state.mirrors[1].enabled, false); assert.equal(state.mirrors[1].blocker, 'rebuild');
    await section.getByText('Scheduling is paused. The recovery reason and saved edits are unchanged.', { exact: true }).waitFor();
    assert.equal(await section.evaluate(e => e.scrollWidth > e.clientWidth), false);
    await page.screenshot({ path: `${artifacts}/success-critical-paused-${width}.png` });
    state.attention = { stage: 'provider_rejected', generation: 'provider_rejected:1', snoozedUntil: null };
    state.mirrors[1].phase = 'running'; state.mirrors[1].recovering = true;
    await section.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await section.getByText('Connection needs attention', { exact: true }).waitFor();
    assert.equal(await section.getByRole('button', { name: /Pause scheduling/ }).count(), 0);
    await section.getByRole('button', { name: 'Remind tomorrow', exact: true }).click();
    await section.getByRole('button', { name: 'Reminder snoozed until tomorrow', exact: true }).waitFor();
    unavailable = true; await section.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await section.getByRole('alert').filter({ hasText: 'Showing last-known status' }).waitFor();
    await page.screenshot({ path: `${artifacts}/active-unavailable-${width}.png` });
    unavailable = false; state.attention.snoozedUntil = null; claimed = false;
    await context.setOffline(true); await page.goto(base + '/').catch(() => {}); await context.setOffline(false);
    await page.goto(base + '/'); await page.getByRole('button', { name: 'Open iCloud settings', exact: true }).waitFor();
    const claimsBeforeOffline = methods.filter(method => method === 'attentionAction').length;
    await context.setOffline(true); await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
    await context.setOffline(false); await page.getByRole('button', { name: 'Open iCloud settings', exact: true }).waitFor();
    assert.equal(methods.filter(method => method === 'attentionAction').length, claimsBeforeOffline);
    const inlineWindow = await context.newPage(); await inlineWindow.goto(base + '/plugins/icloud?configure=icloud');
    await inlineWindow.locator('.pa-icloud__attention').waitFor(); await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
    await inlineWindow.close(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: 'Open iCloud settings', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remind tomorrow', exact: true }).click();
    await page.waitForTimeout(300); assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
    // Model the server's 24-hour snooze expiry without changing the failure
    // generation: a renderer must claim again, not replay its old ownership.
    const actionsBeforeExpiry = methods.filter(method => method === 'attentionAction').length;
    state.attention.snoozedUntil = null; claimed = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: 'Open iCloud settings', exact: true }).waitFor();
    assert.equal(methods.filter(method => method === 'attentionAction').length, actionsBeforeExpiry + 1);
    await page.getByRole('button', { name: 'Remind tomorrow', exact: true }).click();
    await page.waitForTimeout(300); assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
    await page.reload(); await page.waitForTimeout(1000); assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
    await context.close(); console.log(`PASS BB0.49 attention journey, native toast, keyboard, dedupe, failed snooze, protected 2FA, preserved paused/critical, unsuccessful Continue/Pause, active status, offline/reload at ${width}px`);
  }
} finally { await browser.close(); }
