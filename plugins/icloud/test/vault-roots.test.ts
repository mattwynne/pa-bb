import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultRoots } from '../adapters/vault-roots.ts';

test('vault roots use actual configuration directories, not project folder names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-roots-'));
  try {
    await mkdir(join(root, 'Life', '.obsidian'), { recursive: true });
    await mkdir(join(root, 'Life', 'Projects'), { recursive: true });
    await mkdir(join(root, 'Another', '.obsidian'), { recursive: true });
    await mkdir(join(root, 'Not a vault', 'Projects'), { recursive: true });
    assert.deepEqual(await vaultRoots(root), { roots: ['Another', 'Life'], incomplete: false });
    await mkdir(join(root, '.obsidian'));
    assert.deepEqual(await vaultRoots(root), { roots: [''], incomplete: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('symlinked children are not traversed and a symlink marker is not accepted as proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-roots-'));
  const outside = await mkdtemp(join(tmpdir(), 'vault-outside-'));
  try {
    await mkdir(join(outside, '.obsidian'));
    await symlink(outside, join(root, 'escape'));
    assert.deepEqual(await vaultRoots(root), { roots: [], incomplete: false });
    await mkdir(join(root, 'Fake'));
    await symlink(join(outside, '.obsidian'), join(root, 'Fake', '.obsidian'));
    const result = await vaultRoots(root); assert.deepEqual(result.roots, []); assert.equal(result.incomplete, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('unavailable roots are incomplete rather than a confirmed empty catalog', async () => {
  const result = await vaultRoots('/nonexistent-vault-discovery-fixture');
  assert.deepEqual(result, { roots: [], incomplete: true });
});
