// Stock BB on disposable ports and state. Uses a synthetic Obsidian inventory and local ACP agent.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const bb = process.env.BB_REVIEW_APP_ROOT;
const chrome = process.env.BB_REVIEW_CHROME;
assert.ok(bb && chrome, 'Set BB_REVIEW_APP_ROOT and BB_REVIEW_CHROME');
const port = Number(process.env.BB_REVIEW_PORT ?? 43010);
for (const candidate of [port, port + 1]) {
  await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail).listen(candidate, '127.0.0.1', () => server.close(done));
  });
}
const root = await mkdtemp(join(tmpdir(), 'gtd-mention-bb-'));
const evidence = process.env.BB_REVIEW_ARTIFACTS ?? await mkdtemp(join(tmpdir(), 'gtd-mention-evidence-'));
const gtd = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'obsidian');
const home = join(root, 'home');
await Promise.all([mkdir(evidence, { recursive: true }), mkdir(fixture), mkdir(home)]);
const base = `http://127.0.0.1:${port}`;
const env = { PATH: '/usr/bin:/bin', HOME: home, NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'),
  BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: base,
  BB_HOST_DAEMON_PORT: String(port + 1) };
const cli = async (...args) => (await promisify(execFile)(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args],
  { cwd: root, env, timeout: 120000 })).stdout;
const processes = [];
function start(name, entry, ...args) {
  const fd = openSync(join(root, name + '.log'), 'w', 0o600);
  const child = spawn(process.execPath, [join(bb, entry), ...args], { cwd: root, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  processes.push(child);
  return child;
}
async function poll(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail('Disposable BB readiness timed out');
}
const project = { title: 'Build a bench', id: 'Projects/Active/Build a bench.md', menu: 'GTD projects', panel: 'projects' };
const area = { title: 'Learning', id: 'Areas/Learning.md', menu: 'GTD Areas', panel: 'areas' };
const folder = { title: 'Practice', id: 'Areas/Practice/', menu: 'GTD Areas', panel: 'areas' };
const inventory = join(fixture, 'inventory.json');
const inventoryData = {
  source: { vaultId: 'one', name: 'Synthetic vault', cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null },
  notes: [
    { path: project.id, properties: { area: area.id }, malformed: false },
    { path: area.id, properties: {}, malformed: false },
  ],
  folders: ['Projects', 'Projects/Active', 'Areas', folder.id.slice(0, -1)],
  incomplete: false,
};
let browser, page;
try {
  await symlink(join(gtd, 'node_modules'), join(fixture, 'node_modules'));
  await writeFile(inventory, JSON.stringify(inventoryData));
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'bb-plugin-obsidian', version: '0.0.1', type: 'module',
    engines: { node: '>=22', bb: '>=0.50', bbPluginSdk: '>=0.6.157 <1' },
    bb: { name: 'Synthetic Obsidian', description: 'Synthetic GTD inventory', branding: { icon: 'Book' }, server: './server.js' },
  }));
  await writeFile(join(fixture, 'server.js'), `
import { readFile } from 'node:fs/promises';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default bb => {
  const handlers = {
    vaultLocations: () => ({ vaults: [{ id: 'one', root: '', name: 'Synthetic vault' }], incomplete: false }),
    vaultInventory: async input => {
      const data = JSON.parse(await readFile(${JSON.stringify(inventory)}, 'utf8'));
      if (input.folders?.length === 0) return { ...data, notes: [], folders: [] };
      return data;
    },
    inventoryRevision: () => null,
    readNoteSection: () => ({ text: 'Practice weekly.', hash: 'a'.repeat(64) }),
    readSectionLinks: () => ({ links: [], incomplete: false, hash: 'a'.repeat(64) }),
  };
  bb.rpc.register(defineRpcContract(Object.fromEntries(Object.keys(handlers).map(name => [name, {
    input: z.unknown(), output: z.unknown(),
  }]))), handlers);
};
`);
  const server = start('server', 'server/dist/index.js');
  await poll(async () => {
    assert.equal(server.exitCode, null);
    try { return (await fetch(base)).ok; } catch { return false; }
  });
  start('daemon', 'dist/bb-app.js', 'host-daemon', 'join', '--server-url', base);
  await cli('plugin', 'install', fixture, '--yes', '--json');
  await cli('plugin', 'install', gtd, '--yes', '--json');
  await cli('plugin', 'config', 'gtd', 'set', 'vaultId', 'one');
  await cli('plugin', 'config', 'provider-acp', 'set', 'customAgents', JSON.stringify([{
    id: 'gtd-review', displayName: 'Synthetic GTD review', command: process.execPath,
    args: [fileURLToPath(new URL('./mention-review-agent.mjs', import.meta.url))],
  }]));
  await cli('settings', 'general', 'onboardingCompletedAt', new Date().toISOString());
  await poll(async () => JSON.parse(await cli('machine', 'list', '--json')).some(host => host.status === 'connected'));
  const { personalProject } = await (await fetch(base + '/api/v1/sidebar-bootstrap')).json();
  browser = await chromium.launch({ headless: true, executablePath: chrome });

  for (const width of [1280, 390]) {
    const threadTitle = `Synthetic GTD review ${width}`;
    const created = JSON.parse(await cli('thread', 'spawn', '--project', personalProject.id, '--new-environment', 'personal', '--provider',
      'acp-gtd-review', '--title', threadTitle, '--prompt', 'Start synthetic review', '--json'));
    const threadId = created.threadId ?? created.thread?.id ?? created.id;
    assert.ok(threadId, 'Thread creation returned an ID');
    await cli('thread', 'wait', threadId, '--status', 'idle', '--timeout', '30s');
    page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/');
    await page.getByText(threadTitle, { exact: true }).first().click();
    await page.getByText('Synthetic review ready.', { exact: true }).waitFor();
    const threadURL = page.url();
    const editor = page.locator('[data-promptbox-editor-content] [contenteditable="true"]');
    const submit = page.locator('[data-promptbox-submit-action]');
    const sentResponse = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/v1/threads/${threadId}/send`);
    const send = () => width === 390 ? submit.tap() : submit.press('Space');
    const icons = new Map();
    for (const item of [project, area, folder]) {
      await editor.click();
      await page.keyboard.type('Open @' + item.title.slice(0, 5));
      await page.getByText(item.menu, { exact: true }).waitFor();
      const suggestion = page.getByText(item.id, { exact: true });
      await suggestion.waitFor();
      await page.screenshot({ animations: 'disabled', path: join(evidence, `${width}-${item.title}-menu.png`) });
      await page.keyboard.press('Enter');
      const pill = editor.locator('[data-prompt-mention]').filter({ hasText: item.title });
      await pill.waitFor();
      const icon = await pill.locator('svg').innerHTML();
      if (icons.has(item.panel)) assert.equal(icon, icons.get(item.panel));
      else icons.set(item.panel, icon);
      await page.screenshot({ path: join(evidence, `${width}-${item.title}-pill.png`) });
      await page.keyboard.type('in GTD');
      const response = sentResponse();
      await send();
      const accepted = await response;
      assert.equal(accepted.status(), 200, await accepted.text());
      const link = page.getByRole('link', { name: `Open ${item.title} in GTD` });
      await link.waitFor();
      await cli('thread', 'wait', threadId, '--status', 'idle', '--timeout', '30s');
      await page.locator('[data-prompt-mention]').filter({ hasText: item.title }).waitFor();
      await page.getByText(`Resolved one / ${item.id}`, { exact: true }).waitFor();
      const href = await link.getAttribute('href');
      assert.match(href, new RegExp(`^/plugins/gtd/${item.panel}/`));
      const detail = JSON.parse(Buffer.from(href.split('/').at(-1), 'base64url').toString('utf8'));
      assert.deepEqual(detail, ['one', item.id]);
      await link.click();
      await page.getByRole('heading', { name: item.title, exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, href);
      await page.screenshot({ path: join(evidence, `${width}-${item.title}-detail.png`) });
      await page.goBack();
      assert.equal(page.url(), threadURL);
    }
    assert.notEqual(icons.get('projects'), icons.get('areas'), 'Area and project pills display distinct icons');
    await editor.click();
    await page.keyboard.type('Open @Pract');
    await page.getByText(folder.id, { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    await editor.locator('[data-prompt-mention]').filter({ hasText: folder.title }).waitFor();
    await writeFile(inventory, JSON.stringify({ ...inventoryData, folders: inventoryData.folders.slice(0, -1) }));
    const refusal = sentResponse();
    await send();
    const rejected = await refusal;
    assert.equal(rejected.status(), 422);
    assert.match(await rejected.text(), /plugin_mention_resolve_failed/);
    await page.getByText(/This GTD Area is unavailable/).waitFor();
    await writeFile(inventory, JSON.stringify(inventoryData));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Rendered ${width}px: project, landing-note and folder-only mentions, resolved context, detail links, stale send`);
  }
  console.log(`Evidence: ${evidence}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'failure.png') });
  await Promise.all(processes.map((_, index) => {
    const name = index === 0 ? 'server.log' : 'daemon.log';
    return copyFile(join(root, name), join(evidence, name));
  }));
  console.error(`Synthetic failure evidence: ${evidence}`);
  throw error;
} finally {
  await browser?.close();
  for (const child of processes.reverse()) {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
      await exited;
      clearTimeout(kill);
    }
  }
  await rm(root, { recursive: true, force: true });
}
