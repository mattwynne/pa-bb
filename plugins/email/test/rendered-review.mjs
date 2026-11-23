// Run with a built Email and Fastmail, MsgVault 0.26 on PATH, and a local BB app package.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const bb = process.env.BB_REVIEW_APP_ROOT;
const chrome = process.env.BB_REVIEW_CHROME;
assert.ok(bb && chrome, 'Set BB_REVIEW_APP_ROOT and BB_REVIEW_CHROME');
const exec = promisify(execFile);
const port = Number(process.env.BB_REVIEW_PORT ?? 43018);
for (const candidate of [port, port + 1]) await new Promise((ready, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(candidate, '127.0.0.1', () => probe.close(ready));
});
const pkg = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'email-bb-review-'));
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'production',
  BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1',
  BB_SERVER_URL: base, BB_HOST_DAEMON_PORT: String(port + 1),
};
await mkdir(env.HOME);
const fd = openSync(join(root, 'bb.log'), 'w', 0o600);
const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] });
closeSync(fd);
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 60_000 })).stdout;
async function eventually(read, condition) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (condition(value)) return value;
    await delay(250);
  }
  throw new Error('Timed out waiting for the expected BB state.');
}
const status = async () => {
  const value = JSON.parse(await cli('plugin', 'rpc', 'call', 'email', 'status', '--json'));
  return value.result ?? value;
};
let browser;
try {
  await eventually(() => fetch(base).then(r => r.ok).catch(() => false), Boolean);
  await cli('plugin', 'install', pkg, '--yes', '--json');
  await cli('plugin', 'install', resolve(pkg, '../fastmail'), '--yes', '--json');
  assert.equal((await status()).runtime, 'ready');
  assert.deepEqual((await status()).accounts, []);
  await assert.rejects(cli('plugin', 'rpc', 'call', 'fastmail', 'emailArchiveAccounts', '--json'),
    error => /forbidden/.test(error.stdout ?? ''));
  const configuration = await (await fetch(base + '/api/v1/system/config')).json();
  const onboarding = await fetch(base + '/api/v1/settings/general', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...configuration.generalSettings, onboardingCompletedAt: new Date().toISOString() }),
  });
  assert.ok(onboarding.ok, 'Could not mark onboarding complete in the disposable BB instance.');
  const artifacts = process.env.BB_REVIEW_ARTIFACTS;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 880 } });
  await desktop.goto(base + '/plugins/fastmail?configure=fastmail');
  await desktop.getByRole('region', { name: 'Fastmail connection' }).waitFor({ timeout: 10_000 }).catch(async error => { console.error(desktop.url(), (await desktop.locator('body').innerText()).slice(0, 2500)); throw error; });
  await desktop.goto(base + '/plugins/email?configure=email');
  const settings = desktop.getByRole('region', { name: 'Email indexing' });
  await settings.getByRole('heading', { name: 'Set up indexing' }).waitFor();

  const fixture = join(root, 'workspace-fixture');
  await mkdir(fixture);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'bb-plugin-google-workspace', type: 'module', version: '0.0.0',
    bb: { name: 'Workspace fixture', description: 'Synthetic email review source.', branding: { icon: 'Mail' }, server: './server.ts' },
    dependencies: { zod: '4.6.7' },
  }));
  const mime = Buffer.from([
    'From: Sender <sender@example.test>', 'To: Reader <reader@example.test>',
    'Date: Tue, 10 Nov 2026 11:22:33 +0000', 'Message-ID: <private-fixture@example.test>',
    'Subject: PRIVATE_MSGVAULT_FIXTURE', '', 'PRIVATE_MSGVAULT_FIXTURE full message body.', '',
  ].join('\r\n')).toString('base64');
  await writeFile(join(fixture, 'server.ts'), `
    import { z } from 'zod';
    export default bb => bb.rpc.register({
      emailArchiveAccounts: { input: z.null(), output: z.unknown() },
      emailArchivePage: { input: z.object({accountId: z.string(), cursor: z.string().nullable()}), output: z.unknown() },
      emailArchiveMessage: { input: z.object({accountId: z.string(), messageId: z.string()}), output: z.unknown() },
    }, {
      emailArchiveAccounts: (_, ctx) => {
        if (ctx.experimental_caller.pluginId !== 'email') throw Error('Bad caller');
        return [{id:'fixture',email:'reader@example.test'},{id:'failure',email:'error@example.test'}];
      },
      emailArchivePage: ({accountId}) => accountId === 'failure' ? { malformed: 'PRIVATE_MSGVAULT_FIXTURE' } : {ids:['msg-1'],next:null},
      emailArchiveMessage: () => ({status:'ok',mime:${JSON.stringify(mime)}}),
    });
  `);
  await cli('plugin', 'install', fixture, '--yes', '--json');
  await eventually(status, state => state.accounts.length === 2);

  async function checkLayout(region) {
    assert.ok(await region.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Settings overflow horizontally');
  }
  for (const width of [1280, 390]) {
    const page = width === 1280 ? desktop : await browser.newPage({ viewport: { width, height: 880 } });
    await page.goto(base + '/plugins/email?configure=email');
    const region = page.getByRole('region', { name: 'Email indexing' });
    const action = region.getByRole('button', { name: 'Index account reader@example.test' });
    await action.waitFor();
    await action.focus();
    assert.ok(await action.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
    await checkLayout(region);
    if (artifacts) await region.screenshot({ path: join(artifacts, 'accounts-' + width + '.png') });
    if (width !== 390) continue;
    await action.press('Enter');
    await eventually(status, state => state.accounts.some(account => account.indexed === 1 && account.phase === 'searchable'));
    const pause = region.getByRole('button', { name: 'Pause reader@example.test' });
    await pause.waitFor();
    await pause.click();
    await region.getByRole('button', { name: 'Resume reader@example.test' }).waitFor();
    assert.equal((await status()).accounts.find(account => account.email === 'reader@example.test').selected, false);
    await region.getByRole('button', { name: 'Index account error@example.test' }).click();
    await region.getByText('Needs attention', { exact: true }).waitFor();
    await checkLayout(region);
    if (artifacts) await region.screenshot({ path: join(artifacts, 'queued-and-error.png') });
  }
  const log = await cli('plugin', 'logs', 'email', '-n', '15');
  assert.match(log, /Email index_provider failed/);
  assert.doesNotMatch(log, /PRIVATE_MSGVAULT_FIXTURE|@example\.test/);
  assert.doesNotMatch(await readFile(join(root, 'data/logs/server.1.log'), 'utf8'), /PRIVATE_MSGVAULT_FIXTURE/);
  console.log('Disposable BB verified empty, connected, indexed, paused and error states at desktop and narrow sizes. Verified keyboard activation, provider caller refusal and bounded diagnostics.');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const closed = new Promise(resolve => server.once('exit', resolve));
    const timer = setTimeout(() => server.kill('SIGKILL'), 6000);
    server.kill('SIGTERM');
    await closed;
    clearTimeout(timer);
  }
  if (server.exitCode === 0) await rm(root, { recursive: true, force: true });
  else console.error('Disposable BB did not stop cleanly. Review data remains at ' + root);
}
