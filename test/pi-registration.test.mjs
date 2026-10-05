import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { reconcilePiRegistration, removePiRegistration } from '../src/pi-registration.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pa-bb-registration-'));
  const agentDir = join(root, 'agent');
  const packageDir = join(root, 'managed-v1');
  await mkdir(packageDir);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ pi: { extensions: ['./index.js'] } }));
  await writeFile(join(packageDir, 'index.js'), 'export default function () {}');
  try { await fn({ root, agentDir, packageDir }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('creates an owned Pi registration, remains idempotent, and follows a managed update', () => fixture(async ({ root, agentDir, packageDir }) => {
  const first = await reconcilePiRegistration({ agentDir, packageDir });
  assert.equal(first.status, 'created');
  assert.equal((await reconcilePiRegistration({ agentDir, packageDir })).status, 'current');
  const next = join(root, 'managed-v2');
  await mkdir(next);
  await writeFile(join(next, 'package.json'), JSON.stringify({ pi: { extensions: ['./index.js'] } }));
  await writeFile(join(next, 'index.js'), 'export default function () {}');
  assert.equal((await reconcilePiRegistration({ agentDir, packageDir: next })).status, 'updated');
  assert.equal(await readlink(first.link), next);
  assert.equal((await removePiRegistration({ agentDir })).status, 'removed');
  assert.equal((await removePiRegistration({ agentDir })).status, 'absent');
}));

test('does not overwrite or remove somebody else’s Pi extension', () => fixture(async ({ agentDir, packageDir }) => {
  const extensions = join(agentDir, 'extensions');
  await mkdir(extensions, { recursive: true });
  const link = join(extensions, 'pa-bb-google');
  await symlink(packageDir, link);
  await assert.rejects(reconcilePiRegistration({ agentDir, packageDir }), /occupied or incomplete/);
  await assert.rejects(removePiRegistration({ agentDir }), /occupied or incomplete/);
  assert.equal(await readlink(link), packageDir);
}));

test('preserves unrelated settings, extensions, and credential files on update and removal', () => fixture(async ({ agentDir, packageDir }) => {
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), '{"extensions":["./other.js"]}');
  await writeFile(join(agentDir, 'auth.json'), 'leave-me-alone');
  await writeFile(join(agentDir, 'extensions', 'other.js'), 'export default () => {}');
  await reconcilePiRegistration({ agentDir, packageDir });
  await removePiRegistration({ agentDir });
  assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"extensions":["./other.js"]}');
  assert.equal(await readFile(join(agentDir, 'auth.json'), 'utf8'), 'leave-me-alone');
  assert.equal(await readFile(join(agentDir, 'extensions', 'other.js'), 'utf8'), 'export default () => {}');
}));

test('explicit cleanup command removes only an owned registration', () => fixture(async ({ agentDir, packageDir }) => {
  await reconcilePiRegistration({ agentDir, packageDir });
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../spike/cleanup-registration.mjs', import.meta.url)), agentDir], { encoding: 'utf8' });
  assert.match(output, /removed/);
  assert.equal((await removePiRegistration({ agentDir })).status, 'absent');
}));

test('rejects a missing packaged entry before writing registration', () => fixture(async ({ agentDir, packageDir }) => {
  await rm(join(packageDir, 'index.js'));
  await assert.rejects(reconcilePiRegistration({ agentDir, packageDir }), /Missing packaged Pi extension/);
  assert.equal((await removePiRegistration({ agentDir })).status, 'absent');
}));
