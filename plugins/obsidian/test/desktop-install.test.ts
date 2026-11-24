import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { ManagedDesktop, release } from '../adapters/desktop-install.ts';
import { desktopConfiguration } from '../adapters/desktop-links.ts';
import { diagnosticLogger } from '../adapters/diagnostic-log.ts';

test('managed installation verifies before extracting, shares one download and reuses the published bundle offline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'obsidian'), cache = join(root, 'cache');
  await mkdir(join(bundle, 'resources'), { recursive: true });
  for (const name of ['obsidian', 'obsidian-cli', 'resources/obsidian.asar']) {
    await writeFile(join(bundle, name), 'fixture', { mode: 0o700 });
  }
  const archive = join(root, 'fixture.tar.gz');
  await promisify(execFile)('/usr/bin/tar', ['-czf', archive, '-C', root, 'obsidian']);
  const bytes = await readFile(archive);
  const pin = { ...release, sha256: createHash('sha256').update(bytes).digest('hex') };
  const signal = new AbortController().signal;
  const logs: string[] = [];
  const diagnose = diagnosticLogger(line => logs.push(line));
  let calls = 0;
  const install = new ManagedDesktop(cache, diagnose, pin, async () => {
    calls++;
    if (calls === 1) throw new Error('private-token /private/path');
    if (calls === 2) return new Response('private response');
    return new Response(new Uint8Array(bytes));
  });
  for (const failure of ['download_failed', 'checksum_failed']) {
    await assert.rejects(install.ensure(signal), /desktop_setup/);
    assert.equal(install.state, failure);
    assert.deepEqual(await readdir(cache), []);
    await assert.rejects(install.ensure(signal), /desktop_setup/);
    install.retry();
  }
  await Promise.all([install.ensure(signal), install.ensure(signal)]);
  assert.equal(calls, 3);
  assert.equal(await readFile(install.binaries.cli, 'utf8'), 'fixture');
  const offline = new ManagedDesktop(cache, diagnose, pin, () => { throw new Error('offline'); });
  await offline.ensure(signal);
  assert.equal(offline.state, 'installed');
  assert.deepEqual(offline.binaries, install.binaries);
  const badPin = { ...pin, sha256: createHash('sha256').update('broken archive').digest('hex') };
  const broken = new ManagedDesktop(cache, diagnose, badPin, async () => new Response('broken archive'));
  await assert.rejects(broken.ensure(signal), /desktop_setup/);
  assert.equal(broken.state, 'extract_failed');
  assert.equal((await readdir(cache)).length, 1);
  assert.deepEqual(logs, ['Obsidian desktop_install download_failed', 'Obsidian desktop_install checksum_failed', 'Obsidian desktop_install extract_failed']);
});

test('managed defaults preserve saved and environment executable pairs and exact vault selection', () => {
  const env = { PA_OBSIDIAN_DESKTOP: '/env/app', PA_OBSIDIAN_CLI: '/env/cli', PA_OBSIDIAN_DESKTOP_VAULT_ID: 'env', PA_OBSIDIAN_DESKTOP_ROOT: 'nested' };
  assert.deepEqual(desktopConfiguration({}, env), { binaries: { desktop: '/env/app', cli: '/env/cli' }, vaultId: 'env', root: 'nested' });
  const saved = { desktopBinary: '/app', desktopCli: '/cli', desktopVaultId: 'saved' };
  assert.deepEqual(desktopConfiguration(saved, env), { binaries: { desktop: '/app', cli: '/cli' }, vaultId: 'saved', root: undefined });
  assert.deepEqual(desktopConfiguration({ desktopBinary: '/app' }, env), desktopConfiguration({}, env));
  assert.equal(desktopConfiguration({ desktopBinary: '/app' }, {}), undefined);
  assert.deepEqual(desktopConfiguration({ desktopVaultId: 'one', desktopVaultRoot: 'notes' }, {}), { vaultId: 'one', root: 'notes' });
  assert.deepEqual(desktopConfiguration({}, {}), { vaultId: undefined, root: undefined });
});

test('cancelling a reader keeps the shared install alive, while shutdown waits for staging cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stop = new AbortController(), reader = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const desktop = new ManagedDesktop(root, () => {}, release, async (_, init) => {
    calls++;
    started();
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const shared = desktop.ensure(stop.signal);
  await entered;
  const waiting = desktop.ensure(stop.signal, reader.signal);
  reader.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(desktop.state, 'installing');
  assert.equal(calls, 1);
  stop.abort();
  await assert.rejects(shared, /cancelled/);
  await desktop.drain();
  assert.deepEqual(await readdir(root), []);
  assert.equal(desktop.state, 'pending');
});
