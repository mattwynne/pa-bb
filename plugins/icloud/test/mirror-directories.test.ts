import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDirectories } from '../adapters/mirror-directories.ts';

test('directory discovery uses the supplied marker and prunes exclusions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-roots-'));
  try {
    await mkdir(join(root, 'Life', '.marker'), { recursive: true });
    await mkdir(join(root, 'Life', 'Projects'), { recursive: true });
    await mkdir(join(root, 'Another', '.marker'), { recursive: true });
    await mkdir(join(root, 'Not a vault', 'Projects'), { recursive: true });
    await mkdir(join(root, 'skip', 'Inside', '.marker'), { recursive: true });
    assert.deepEqual(await findDirectories(root, '.marker', ['skip']), { directories: ['Another', 'Life'], incomplete: false });
    await mkdir(join(root, '.marker'));
    assert.deepEqual(await findDirectories(root, '.marker', ['skip']), { directories: [''], incomplete: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('symlinked children are not traversed and a symlink marker is not accepted as proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vault-roots-'));
  const outside = await mkdtemp(join(tmpdir(), 'vault-outside-'));
  try {
    await mkdir(join(outside, '.marker'));
    await symlink(outside, join(root, 'escape'));
    assert.deepEqual(await findDirectories(root, '.marker', ['skip']), { directories: [], incomplete: false });
    await mkdir(join(root, 'Fake'));
    await symlink(join(outside, '.marker'), join(root, 'Fake', '.marker'));
    const result = await findDirectories(root, '.marker', ['skip']); assert.deepEqual(result.directories, []); assert.equal(result.incomplete, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('unavailable roots are incomplete rather than a confirmed empty catalog', async () => {
  const result = await findDirectories('/nonexistent-directory-discovery-fixture', '.marker', []);
  assert.deepEqual(result, { directories: [], incomplete: true });
});
