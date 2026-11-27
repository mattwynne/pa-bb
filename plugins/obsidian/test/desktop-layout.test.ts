// Real Obsidian Desktop: set PA_OBSIDIAN_TEST_DESKTOP and PA_OBSIDIAN_TEST_CLI.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DesktopLinks } from '../adapters/desktop-links.ts';

const binaries = { desktop: process.env.PA_OBSIDIAN_TEST_DESKTOP, cli: process.env.PA_OBSIDIAN_TEST_CLI };

test('BB\'s Desktop Obsidian never rewrites the synced workspace layout', {
  skip: !binaries.desktop || !binaries.cli, timeout: 60_000,
}, async t => {
  const owner = await mkdtemp('/tmp/pa-desktop-layout-');
  t.after(() => rm(owner, { recursive: true, force: true }));
  const root = join(owner, 'vault');
  await mkdir(join(root, '.obsidian'), { recursive: true });
  await writeFile(join(root, 'One.md'), '# One\n');
  await writeFile(join(root, 'Two.md'), '# Two\n');
  const workspace = join(root, '.obsidian', 'workspace.json');
  // The layout another device saved, which BB must leave alone.
  await writeFile(workspace, '{"from":"another device"}');
  const runner = new DesktopLinks({ desktop: binaries.desktop!, cli: binaries.cli! }, () => {});
  t.after(() => runner.stop());
  const target = { id: 'fixture', directory: root, identity: 'fixture' };
  const run = async (code: string) => (await runner.run(target, { kind: 'eval', code }, async () => {}) as { value: unknown });

  await runner.run(target, { kind: 'start' }, async () => {});
  // Change the layout the way a session does, then force every save path.
  assert.equal((await run(`(async () => {
    for (const path of ["One.md", "Two.md"]) await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(path));
    app.workspace.requestSaveLayout();
    app.workspace.requestSaveLayout.run();
    await app.workspace.saveLayout();
    return true;
  })()`)).value, true);
  await delay(3000);

  assert.equal(await readFile(workspace, 'utf8'), '{"from":"another device"}');
});
