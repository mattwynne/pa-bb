import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { desktopConfiguration, DesktopLinks } from '../adapters/desktop-links.ts';
import { diagnosticLogger } from '../adapters/diagnostic-log.ts';
import { ICloud } from '../adapters/icloud.ts';
import { LocalReceipts } from '../adapters/local-receipts.ts';
import { VaultError, type DesktopLinkOperation } from '../core/ports.ts';

const category = (expected: string) => (error: unknown) => error instanceof VaultError && error.category === expected;
const lookup = { kind: 'backlinks', path: 'Folder A/Note "One" = A.md' } as const;

async function fixture(t: TestContext) {
  const base = await mkdtemp('/tmp/pa-desktop-test-');
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, 'mirror');
  const vault = join(directory, 'Nested Vault');
  const trace = join(base, 'trace');
  const behavior = join(base, 'behavior');
  const desktop = join(base, 'desktop.cjs'), cli = join(base, 'cli.cjs');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await mkdir(join(vault, 'Folder A'));
  await writeFile(join(vault, lookup.path), '# Exact');
  await writeFile(behavior, 'good');
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const profile = path.join(process.env.XDG_CONFIG_HOME, 'obsidian');
const config = JSON.parse(fs.readFileSync(path.join(profile, 'obsidian.json')));
const trace = ${JSON.stringify(trace)};
const behavior = fs.readFileSync(${JSON.stringify(behavior)}, 'utf8');
const id = 'vault-123';
assert.deepEqual(Object.keys(config.vaults), [id]);
assert.equal(config.cli, true);
assert.equal(config.vaults[id].path, ${JSON.stringify(vault)});
assert.equal(fs.statSync(process.cwd()).mode & 0o777, 0o700);
assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
assert.equal(fs.statSync(process.env.XDG_RUNTIME_DIR).mode & 0o777, 0o700);
assert.equal(fs.statSync(path.join(profile, 'obsidian.json')).mode & 0o777, 0o600);
assert.equal(process.env.PA_DESKTOP_TEST_SECRET, undefined);
assert.equal(process.env.ELECTRON_DISABLE_SANDBOX, undefined);
const events = (...args) => fs.appendFileSync(trace, JSON.stringify(args) + '\\n');
`;
  await writeFile(desktop, script + `
assert.ok(process.argv.slice(2).includes('--user-data-dir=' + profile));
assert.ok(!process.argv.slice(2).some(arg => arg.includes('no-sandbox') || arg.includes('remote-debugging')));
events('start', process.cwd(), process.pid);
require('node:net').createServer().listen(path.join(process.env.XDG_RUNTIME_DIR, '.obsidian-cli.sock'));
`, { mode: 0o700 });
  await writeFile(cli, script + `
const [selector, command, ...args] = process.argv.slice(2);
assert.equal(selector, 'vault=' + id);
if (command === 'eval') {
  if (args[0].includes('window.close')) {
    const matchingStart = fs.readFileSync(trace, 'utf8').trim().split('\\n').map(line => JSON.parse(line))
      .find(row => row[0] === 'start' && row[1] === process.cwd());
    process.kill(matchingStart[2], 'SIGTERM');
    console.log('=> closing');
  } else {
    console.log('=> ' + JSON.stringify({ directory: config.vaults[id].path, restricted: behavior !== 'unrestricted', updateLinks: true }));
  }
} else {
  events(command, ...args);
  if (behavior === 'malformed') console.log('Error: sentinel-private reply');
  else if (behavior === 'limit') process.stdout.write('sentinel-private'.repeat(100000));
  else if (behavior === 'lost') { console.error('sentinel-private stderr'); process.exitCode = 1; }
  else if (behavior === 'hang') setInterval(() => {}, 1000);
  else if (behavior === 'translated-limit') console.log(JSON.stringify([{ file: ['x'.repeat(250), 'y'.repeat(250), 'z'.repeat(250), 'a'.repeat(250), 'LongName.md'].join('/') }]));
  else if (behavior === 'escaped-limit') console.log(JSON.stringify(Array.from({ length: 1250 }, (_, i) => ({
    file: String(i).padStart(4, '0') + '"'.repeat(200) + '.md',
  }))));
  else if (command === 'backlinks') console.log(JSON.stringify([{ file: 'Ref.md' }]));
  else console.log('Renamed: ' + args[0].slice(5) + ' -> Folder A/' + args[1].slice(5));
}
`, { mode: 0o700 });
  const calls: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const diagnose = diagnosticLogger(message => logs.push(message));
  const stats = await lstat(directory, { bigint: true });
  const grant = { directory, rootDev: String(stats.dev), rootIno: String(stats.ino) };
  let mode = 'ready', grantCount = 0, refuseAt = Infinity, revokeAt = Infinity, revoked = false;
  const sdk = { plugins: {
    async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
    async callRpc(request: { method: string; input: unknown; outputSchema: { parse(value: unknown): unknown } }) {
      calls.push([request.method, request.input]);
      const mirror = { id: 'vault-123', folder: { name: 'Mirror' }, initialized: true, enabled: true, phase: 'paused',
        lastSuccess: null, failure: null, filesystem: mode, local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } };
      if (request.method === 'mirrorDirectoryGrant') {
        if (++grantCount >= refuseAt) throw new Error('sentinel-private grant');
        if (grantCount >= revokeAt) revoked = true;
      }
      return request.outputSchema.parse({
        status: { noteAccessVersion: 2, mirrorAccessVersion: 3, available: true, connected: true, challenge: null, mirrors: [mirror] },
        mirrorDirectoryCapabilities: { mirrorDirectoryGrantVersion: 1 },
        mirrorDirectoryGrant: grant,
      }[request.method]);
    },
  } } as unknown as BbPluginApi['sdk'];
  const binaries = { desktop, cli };
  const kv = { async get() { return undefined; } } as unknown as BbPluginApi['storage']['kv'];
  const adapter = new ICloud(sdk, diagnose, kv, undefined, { ...binaries, vaultId: 'vault-123' });
  t.after(() => adapter.stop());
  const target = { mirrorId: 'vault-123', revision: 17 };
  return { vault, binaries, diagnose, target, logs, calls, grant, adapter, kv,
    mode(value: string) { mode = value; }, refuse(at: number) { refuseAt = at; }, revoke(at: number) { revokeAt = at; },
    behavior: (value: string) => writeFile(behavior, value),
    events: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    run: (operation: DesktopLinkOperation = lookup) => adapter.desktopLink(target,
      operation.kind === 'backlinks' ? { ...operation, path: 'Nested Vault/' + operation.path }
        : { ...operation, path: 'Nested Vault/' + operation.path, destination: 'Nested Vault/' + operation.destination },
      undefined, () => { if (revoked) throw new VaultError('not_connected'); }),
  };
}

test('Desktop defaults off and routes legacy before opening a profile', async t => {
  assert.equal(desktopConfiguration({}), undefined);
  assert.equal(desktopConfiguration({ PA_OBSIDIAN_DESKTOP: '/desktop', PA_OBSIDIAN_CLI: '/cli' }), undefined);
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.desktopLink({ ...f.target, mirrorId: 'unselected' }, lookup), { route: 'existing' });
  assert.deepEqual(f.calls, []);
  f.mode('legacy_pending');
  assert.deepEqual(await f.run(), { route: 'existing' });
  assert.deepEqual(f.calls, [['status', null]]);
  await assert.rejects(f.events(), { code: 'ENOENT' });
});

test('direct route pins the exact grant and translates its nested vault paths', async t => {
  const f = await fixture(t);
  const saved = process.env.PA_DESKTOP_TEST_SECRET;
  process.env.PA_DESKTOP_TEST_SECRET = 'sentinel-private';
  t.after(() => {
    if (saved === undefined) delete process.env.PA_DESKTOP_TEST_SECRET;
    else process.env.PA_DESKTOP_TEST_SECRET = saved;
  });
  const result = await f.run();
  assert.equal(result.route, 'desktop');
  assert.equal(result.root, 'Nested Vault');
  assert.deepEqual(result.result, { kind: 'backlinks', sources: ['Nested Vault/Ref.md'] });
  assert.deepEqual(f.calls.filter(([method]) => method === 'mirrorDirectoryGrant'),
    Array.from({ length: 4 }, () => ['mirrorDirectoryGrant', f.target]));
  assert.ok(result.checkAccess);
  await result.checkAccess();
  const [start, command] = await f.events();
  assert.deepEqual(command, ['backlinks', 'path=' + lookup.path, 'format=json']);
  await assert.rejects(lstat(start[1]), { code: 'ENOENT' });
  assert.throws(() => process.kill(start[2], 0), { code: 'ESRCH' });
});

test('path and grant failures refuse before a command without falling through to legacy', async t => {
  const f = await fixture(t);
  await symlink(join(f.vault, lookup.path), join(f.vault, 'Link.md'));
  await assert.rejects(f.run({ ...lookup, path: 'Link.md' }), category('invalid_path'));
  await assert.rejects(f.run({ kind: 'rename', path: lookup.path, destination: 'Different/Renamed.md' }), category('unsupported'));
  await assert.rejects(f.events(), { code: 'ENOENT' });
  // One grant was spent on the symlink preflight. Reject the last check before dispatch.
  f.refuse(4);
  await assert.rejects(f.run(), category('source_unavailable'));
  assert.deepEqual((await f.events()).map(event => event[0]), ['start']);
  assert.ok(f.calls.every(([method]) => !method.startsWith('note')));
  assert.doesNotMatch(f.logs.join('\n'), /sentinel-private/);
});

test('startup refusal, CLI output and lost rename are bounded and private', async t => {
  const f = await fixture(t);
  const runner = new DesktopLinks(f.binaries, f.diagnose);
  const run = (operation: DesktopLinkOperation = lookup) =>
    runner.run({ id: f.target.mirrorId, directory: f.vault }, operation, async () => {});
  await f.behavior('unrestricted');
  await assert.rejects(run(), category('desktop_restricted'));
  await f.behavior('malformed');
  await assert.rejects(run(), category('desktop_reply'));
  await f.behavior('limit');
  await assert.rejects(run(), category('output_limit'));
  await f.behavior('lost');
  await assert.rejects(run({ kind: 'rename', path: lookup.path, destination: 'Folder A/Renamed Extra.md' }), category('uncertain'));
  assert.deepEqual(f.logs, ['Obsidian desktop_start desktop_restricted', 'Obsidian desktop_command desktop_reply',
    'Obsidian desktop_command output_limit', 'Obsidian desktop_command unavailable']);
  const events = await f.events();
  assert.deepEqual(events.filter(event => event[0] === 'rename'), [
    ['rename', 'path=' + lookup.path, 'name=Renamed Extra.md'],
  ]);
  for (const [, path, pid] of events.filter(event => event[0] === 'start')) {
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('a grant refusal after an acknowledged rename remains uncertain', async t => {
  const f = await fixture(t);
  f.refuse(4);
  await assert.rejects(f.run({ kind: 'rename', path: lookup.path, destination: 'Folder A/Renamed.md' }), category('uncertain'));
  assert.deepEqual((await f.events()).map(event => event[0]), ['start', 'rename']);
  assert.ok(f.calls.every(([method]) => !method.startsWith('note')));
});

test('selection changes fence native dispatch and final publication even with an unchanged grant', async t => {
  const before = await fixture(t);
  before.revoke(3);
  await assert.rejects(before.run(), category('not_connected'));
  assert.deepEqual((await before.events()).map(event => event[0]), ['start']);
  const after = await fixture(t);
  after.revoke(4);
  await assert.rejects(after.run(), category('not_connected'));
  assert.deepEqual((await after.events()).map(event => event[0]), ['start', 'backlinks']);
  const rename = await fixture(t);
  rename.revoke(4);
  await assert.rejects(rename.run({ kind: 'rename', path: lookup.path, destination: 'Folder A/Renamed.md' }), category('uncertain'));
  assert.deepEqual((await rename.events()).map(event => event[0]), ['start', 'rename']);
});

test('a translated backlink path must fit the mirror-relative path bound', async t => {
  const f = await fixture(t);
  await f.behavior('translated-limit');
  await assert.rejects(f.run(), category('invalid_path'));
  assert.deepEqual((await f.events()).map(event => event[0]), ['start', 'backlinks']);
});

test('translated backlink JSON, including escaped quotes and delimiters, must fit the existing byte cap', async t => {
  const f = await fixture(t);
  await f.behavior('escaped-limit');
  await assert.rejects(f.run(), category('output_limit'));
  assert.deepEqual((await f.events()).map(event => event[0]), ['start', 'backlinks']);
  assert.equal(f.logs.at(-1), 'Obsidian filesystem output_limit');
});

test('a cancelled queued rename returns before its writer predecessor and never enters', async t => {
  const { kv } = await fixture(t);
  const ledger = new LocalReceipts(kv);
  let release!: () => void, entered = false;
  const held = ledger.run(() => new Promise<void>(resolve => { release = resolve; }));
  const signal = new AbortController();
  await Promise.resolve();
  const queued = ledger.run(async () => { entered = true; }, signal.signal);
  signal.abort();
  try { await assert.rejects(Promise.race([queued, delay(1000)]), category('cancelled')); }
  finally { release(); await held; }
  await ledger.run(async () => {});
  assert.equal(entered, false);
});

test('abort after rename dispatch stops the session and never replays the command', async t => {
  const f = await fixture(t);
  const runner = new DesktopLinks(f.binaries, f.diagnose);
  t.after(() => runner.stop());
  await f.behavior('hang');
  const controller = new AbortController();
  const result = runner.run({ id: f.target.mirrorId, directory: f.vault },
    { kind: 'rename', path: lookup.path, destination: 'Folder A/Renamed.md' }, async () => {}, controller.signal);
  const rejected = assert.rejects(result, category('uncertain'));
  const deadline = Date.now() + 2000;
  let dispatched = false;
  while (!dispatched && Date.now() < deadline) {
    dispatched = (await f.events().catch(() => [])).some(event => event[0] === 'rename');
    if (!dispatched) await delay(20);
  }
  controller.abort();
  await rejected;
  assert.equal(dispatched, true);
  const [start, ...commands] = await f.events();
  assert.equal(commands.length, 1);
  await assert.rejects(lstat(start[1]), { code: 'ENOENT' });
  assert.throws(() => process.kill(start[2], 0), { code: 'ESRCH' });
});
