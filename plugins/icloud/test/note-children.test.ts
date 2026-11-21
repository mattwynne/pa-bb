import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteChildren } from '../adapters/note-children.ts';
test('bounded immediate children include empty and attachment-only directories without reading note bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'children-'));
  try {
    await mkdir(join(root, 'Projects', 'Empty'), { recursive: true });
    await mkdir(join(root, 'Projects', 'Attachments'));
    await writeFile(join(root, 'Projects', 'Attachments', 'image.bin'), 'private-sentinel');
    await writeFile(join(root, 'Projects', 'Plan.md'), 'private-sentinel');
    await writeFile(join(root, 'Projects', 'ignored.bin'), 'private-sentinel');
    assert.deepEqual(await noteChildren(root, 'Projects'), { entries: [{ name: 'Attachments', kind: 'directory' }, { name: 'Empty', kind: 'directory' }, { name: 'Plan.md', kind: 'markdown' }], incomplete: false });
    assert.deepEqual(await noteChildren(root, 'Projects/Empty'), { entries: [], incomplete: false });
    await symlink(join(root, 'Projects'), join(root, 'Link'));
    assert.equal((await noteChildren(root, 'Link')).incomplete, true);
    await symlink(join(root, 'Projects', 'Empty'), join(root, 'Projects', 'Not-a-project'));
    const links = await noteChildren(root, 'Projects');
    assert.equal(links.incomplete, true); assert.ok(!links.entries.some(e => e.name === 'Not-a-project'));
    for (const folder of ['../Projects', '/Projects', 'Projects/../Projects', 'Projects\\Empty']) await assert.rejects(noteChildren(root, folder));
    assert.equal((await noteChildren(root, 'Missing')).incomplete, true);
    assert.equal((await noteChildren(root, 'Projects', AbortSignal.abort())).incomplete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('entry limits cannot turn a truncated listing into complete coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'children-limit-'));
  try {
    await mkdir(join(root, 'Projects'));
    for (let i = 0; i < 5002; i++) await mkdir(join(root, 'Projects', `Entry-${i}`));
    const page = await noteChildren(root, 'Projects');
    assert.equal(page.incomplete, true); assert.ok(page.entries.length <= 5000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
