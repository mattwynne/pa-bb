// Real stock BB and unchanged production UI/core, with generated OAuth/provider data in a disposable source fixture.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
const pkg = fileURLToPath(new URL('../', import.meta.url));
const bb = process.env.BB_REVIEW_APP_ROOT ?? join(pkg, 'node_modules/bb-app');
const chrome = process.env.BB_REVIEW_CHROME;
assert.ok(chrome, 'Set BB_REVIEW_CHROME to a local Chrome executable');
const root = await mkdtemp(join(tmpdir(), 'xero-bb-review-')), source = join(root, 'source');
const port = Number(process.env.BB_REVIEW_PORT ?? 43028), base = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_APP_URL: base, BB_SERVER_URL: base, BB_HOST_DAEMON_PORT: String(port + 1) };
await mkdir(env.HOME); await mkdir(source);
for (const file of ['package.json', 'app.tsx', 'app.css', 'contract.ts', 'connection-ui.tsx', 'connection-ui.css', 'connection.ts', 'accounting.ts', 'diagnostic.ts', 'attachment.ts', 'skills', 'references']) await cp(join(pkg, file), join(source, file), { recursive: true });
await cp(join(pkg, 'server.ts'), join(source, 'production.ts'));
await symlink(join(pkg, 'node_modules'), join(source, 'node_modules'));
await writeFile(join(source, 'server.ts'), `
import plugin from './production.ts';
import { SCOPES } from './connection.ts';
import { z } from 'zod';
export default async bb => {
  let mode = 'connected';
  await plugin(bb, { fetcher: async (url, init) => {
    if (mode === 'failure') throw new Error('SECRET_SENTINEL PRIVATE_ACCOUNT');
    if (String(url).includes('/connect/token')) return Response.json({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 1800, scope: SCOPES.join(' ') });
    if (String(url).endsWith('/connections')) return Response.json(mode === 'empty' ? [] : [{ tenantId: '11111111-1111-4111-8111-111111111111', tenantName: 'Example organisation', tenantType: 'ORGANISATION' }]);
    return Response.json({ Organisations: [{ Name: 'Example organisation' }] });
  } });
  bb.rpc.register({ fixtureMode: { input: z.enum(['connected', 'failure', 'empty']), output: z.null() } }, { fixtureMode: input => { mode = input; return null; } });
};
`);
const fd = openSync(join(root, 'bb.log'), 'w', 0o600);
const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] }); closeSync(fd);
const exec = promisify(execFile);
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 90_000 })).stdout;
async function eventually(read, condition) {
  for (let i = 0; i < 120; i++) { const value = await read(); if (condition(value)) return value; await delay(250); }
  throw new Error('Timed out waiting for BB state');
}
const input = join(root, 'input.json');
async function rpc(method, value = null) {
  await writeFile(input, JSON.stringify(value)); const response = JSON.parse(await cli('plugin', 'rpc', 'call', 'xero', method, '--input-file', input, '--json')); return response?.result ?? response;
}
let browser;
try {
  await eventually(() => fetch(base).then(r => r.ok).catch(() => false), Boolean);
  await cli('plugin', 'install', source, '--yes', '--json');
  const config = await (await fetch(base + '/api/v1/system/config')).json();
  assert.ok((await fetch(base + '/api/v1/settings/general', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config.generalSettings, onboardingCompletedAt: new Date().toISOString() }) })).ok);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on('pageerror', e => console.error('Browser error:', e.message));
  // All provider navigation is intercepted; there is never a real Xero login.
  await page.route('https://login.xero.com/**', route => {
    const u = new URL(route.request().url()), callback = new URL(u.searchParams.get('redirect_uri')); callback.searchParams.set('state', u.searchParams.get('state')); callback.searchParams.set('code', 'SECRET_CODE');
    return route.fulfill({ contentType: 'text/html', body: '<main><h1>Synthetic Xero consent</h1><a href="' + callback.toString().replaceAll('&', '&amp;') + '">Approve example organisation</a></main>' });
  });
  const url = base + '/plugins/xero?configure=xero';
  const region = () => page.getByRole('region', { name: 'Xero connection' });
  const artifacts = process.env.BB_REVIEW_ARTIFACTS;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  async function screen(name) {
    assert.ok(await region().evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Xero region overflows');
    if (artifacts) await region().screenshot({ path: join(artifacts, name + '.png') });
  }
  if (process.env.BB_REVIEW_REFERENCE_PLUGIN) {
    await cli('plugin', 'install', process.env.BB_REVIEW_REFERENCE_PLUGIN, '--yes', '--json');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(base + '/plugins/fastmail?configure=fastmail');
      const reference = page.getByRole('region', { name: 'Fastmail connection' }); await reference.waitFor();
      if (artifacts) await reference.screenshot({ path: join(artifacts, 'reference-fastmail-' + width + '.png') });
    }
    await page.setViewportSize({ width: 1280, height: 960 });
  }
  await page.goto(url); await region().getByRole('heading', { name: 'Get started' }).waitFor();
  assert.ok(await region().getByRole('button', { name: 'Connect Xero', exact: true }).isDisabled());
  assert.equal(await region().locator('code').textContent(), base + '/api/v1/plugins/xero/http/callback');
  assert.equal(await region().locator('ol').evaluate(el => getComputedStyle(el).listStyleType), 'decimal');
  await screen('first-run-desktop');
  await page.setViewportSize({ width: 390, height: 880 }); await screen('first-run-narrow');
  const copy = region().getByRole('button', { name: 'Copy Xero callback URL' }); await copy.focus();
  assert.ok(await copy.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
  await cli('plugin', 'config', 'xero', 'set', 'clientId', 'EXAMPLE_CLIENT');
  await cli('plugin', 'config', 'xero', 'set', 'clientSecret', 'SECRET_CLIENT');
  await page.reload(); await region().getByRole('button', { name: 'Connect Xero', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic Xero consent' }).waitFor();
  await page.getByRole('link', { name: 'Approve example organisation' }).click();
  await eventually(() => rpc('status'), s => s.connected && s.organisations.length === 1);
  // Host navigation is reviewed, not assumed from the redirect header alone.
  await region().getByRole('heading', { name: 'Connected organisations' }).waitFor({ timeout: 10_000 });
  assert.equal(await region().getByText('Use your own Xero app', { exact: true }).count(), 0);
  await region().getByRole('button', { name: 'Check access to Example organisation' }).focus();
  await page.keyboard.press('Enter'); await region().getByText('Read verified', { exact: true }).waitFor();
  await screen('connected-narrow'); await page.setViewportSize({ width: 1280, height: 960 }); await screen('connected-desktop');
  await rpc('fixtureMode', 'failure'); await region().getByRole('button', { name: 'Check access to Example organisation' }).click();
  await region().getByRole('alert').filter({ hasText: 'Could not reach Xero' }).waitFor();
  assert.equal(await region().getByRole('alert').count(), 1, 'One actionable error, not a repeated generic failure');
  await screen('error-desktop'); await page.setViewportSize({ width: 390, height: 880 }); await screen('error-narrow');
  assert.doesNotMatch(await region().innerText(), /SECRET|PRIVATE_ACCOUNT/);
  await rpc('fixtureMode', 'empty'); await region().getByRole('button', { name: 'Refresh organisations' }).click();
  await region().getByText(/No organisations were returned/).waitFor(); await screen('empty-narrow');
  await page.setViewportSize({ width: 1280, height: 960 }); await screen('empty-desktop');
  await rpc('fixtureMode', 'connected'); await region().getByRole('button', { name: 'Refresh organisations' }).click();
  await region().getByRole('button', { name: 'Check access to Example organisation' }).waitFor();
  let confirmed = false;
  page.once('dialog', async dialog => { assert.match(dialog.message(), /all its organisations/); confirmed = true; await dialog.accept(); });
  await region().getByRole('button', { name: 'Disconnect', exact: true }).click(); await region().getByRole('heading', { name: 'Get started' }).waitFor(); assert.ok(confirmed);
  assert.equal((await rpc('status')).connected, false);
  const logs = await cli('plugin', 'logs', 'xero', '-n', '15'); assert.match(logs, /Xero accounting_read transport/); assert.doesNotMatch(logs, /SECRET|PRIVATE_ACCOUNT/);
  console.log('Verified real BB: first-run, pending provider consent, connected, verified read, empty, error/recovery and disconnect confirmation; desktop/narrow, keyboard activation, safe bounded logs. Synthetic provider only.');
} catch (error) {
  console.error('Review artifacts and disposable data:', root);
  console.error((await readFile(join(root, 'bb.log'), 'utf8')).split('\n').slice(-12).join('\n'));
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); const timer = setTimeout(() => server.kill('SIGKILL'), 6000); server.kill('SIGTERM'); await stopped; clearTimeout(timer); }
  if (server.exitCode === 0) await rm(root, { recursive: true, force: true });
}
