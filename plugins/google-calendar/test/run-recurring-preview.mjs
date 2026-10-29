// Opt-in rendered review fixture. Installs only into a fresh, credential-free BB.
// The production Approval component is mounted in BB Settings with synthetic
// proposals, not a real thread interaction. Native consent is covered by host
// tests. No accounts are connected and no Google writes are possible here.
// BB_REVIEW_ROOT: a built BB checkout (apps/server + apps/host-daemon), or bb-app.
// Run this controller, inspect its printed URL, then SIGTERM for cleanup.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, symlink, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const bbRoot = process.env.BB_REVIEW_ROOT || join(source, 'node_modules/bb-app');
let apps = join(bbRoot, 'apps');
try { await access(apps); } catch { apps = bbRoot; }
const cli = join(apps, 'host-daemon/dist/bb');
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const root = await mkdtemp(join(tmpdir(), 'gcal-recurring-preview-'));
const fixture = join(root, 'google-calendar');
await mkdir(join(root, 'home'));
await cp(source, fixture, { recursive: true, filter: path => !['node_modules', 'dist', 'test'].some(name => path === join(source, name) || path.startsWith(join(source, name) + '/')) });
await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'), 'dir');
let app = await readFile(join(fixture, 'app.tsx'), 'utf8');
app = app.replace("export default definePluginApp(app => {", `
function RecurringPreview() {
  const state = new URLSearchParams(window.location.search).get('reviewState') || 'forever';
  const [choice, setChoice] = useState('');
  const proposed = { summary: 'Synthetic recurring appointment', start: '2026-10-29T14:30:00-07:00', end: '2026-10-29T17:00:00-07:00', timeZone: 'America/Vancouver', recurrence: { frequency: 'weekly', byDay: ['TH'], ...(state === 'count' ? { interval: 2, byDay: ['MO', 'TH'], count: 5 } : state === 'until' ? { until: '2026-12-03T21:30:00Z' } : state === 'invalid' ? { frequency: 'daily' } : {}) } };
  const operation = state.startsWith('update-') ? 'update' : state === 'delete-series' ? 'delete' : 'create';
  const currentEvent = { id: 'synthetic-series', summary: 'Synthetic recurring appointment', start: { dateTime: proposed.start, timeZone: proposed.timeZone }, end: { dateTime: proposed.end, timeZone: proposed.timeZone }, ...(state === 'update-occurrence' ? { recurringEventId: 'synthetic-parent' } : { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'] }) };
  return <section aria-label="Synthetic approval fixture"><p>Example only — no Google access or writes.</p><Approval interaction={{ id: state, payload: { operation, account: 'person@example.test', calendarId: 'synthetic-calendar', proposed: operation !== 'create' ? { eventId: currentEvent.id, ...(operation === 'update' ? { summary: 'Synthetic new title' } : {}) } : state === 'oneoff' ? { ...proposed, recurrence: undefined } : proposed, context: { calendarName: 'Synthetic calendar', ...(operation !== 'create' ? { currentEvent } : {}) } } }} submit={async value => {
    if (state === 'error') throw new Error('Synthetic submit failure');
    if (state === 'pending') await new Promise(() => {});
    setChoice(JSON.stringify(value));
  }} /><output aria-label="Synthetic choice">{choice}</output></section>;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'synthetic-recurring-preview', component: RecurringPreview });`);
await writeFile(join(fixture, 'app.tsx'), app);
await writeFile(join(fixture, 'preview-server.ts'), `
import plugin from './server.js';
import { z } from 'zod';
export default async function(bb) {
  let create;
  const wrapped = { ...bb, agents: { ...bb.agents, registerTool(tool) { if (tool.name === 'gcal_create_event') create = tool; return bb.agents.registerTool(tool); } } };
  await plugin(wrapped);
  bb.rpc.register({ syntheticInvalid: { input: z.null(), output: z.any() } }, {
    async syntheticInvalid() { return create.execute({ recurrence: { frequency: 'weekly', byDay: ['TH'] }, timeZone: 'synthetic-private/sentinel' }, { threadId: 'unused', signal: new AbortController().signal }); }
  });
}
`);
const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
manifest.bb.server = './preview-server.ts';
await writeFile(join(fixture, 'package.json'), JSON.stringify(manifest));
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_CLI: cli, BB_MARKETPLACE_URL: `http://127.0.0.1:${port}/no-marketplace` };
const fd = openSync(join(root, 'server.log'), 'a', 0o600);
const server = spawn(process.execPath, [join(apps, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] });
closeSync(fd);
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 10000); timer.unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('exit', async code => { if (stopping && code === 0) await rm(root, { recursive: true, force: true }); process.exit(stopping ? 0 : 1); });
const command = async (...args) => (await exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(server.exitCode, null);
    try { ready = (await fetch(env.BB_SERVER_URL, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Disposable BB did not start');
  const installed = JSON.parse(await command('plugin', 'install', fixture, '--yes', '--json'));
  assert.equal(installed.plugin.status, 'running');
  // Same shared connection UI, comparable real plugin in the actual BB host.
  await command('plugin', 'install', resolve(source, '../google-drive'), '--yes', '--json');
  const status = await command('plugin', 'rpc', 'call', 'google-calendar', 'status', '--json');
  const invalid = await command('plugin', 'rpc', 'call', 'google-calendar', 'syntheticInvalid', '--json');
  const logs = await command('plugin', 'logs', 'google-calendar', '-n', '5');
  assert.match(status, /"accounts":\s*\[\]/);
  assert.match(invalid, /IANA timeZone/);
  assert.match(logs, /agent_tool gcal_create_event recurrence_invalid/);
  assert.doesNotMatch(logs, /synthetic-private|sentinel/);
  console.log(JSON.stringify({ root, url: `${env.BB_SERVER_URL}/settings/plugins/google-calendar`, controllerPid: process.pid, status: 'running', connectedAccounts: 0, writes: 0, diagnostic: 'recurrence_invalid', renderedFixture: 'production Approval in BB Settings; not native thread input' }));
} catch (error) { console.error('Disposable preview failed; logs:', join(root, 'server.log')); stop(); throw error; }
