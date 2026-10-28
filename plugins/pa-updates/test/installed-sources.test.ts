import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { applicationPorts } from '../adapters/application.ts';
import { sourceGeneration } from '../adapters/source-mode.ts';
import { originUrl } from '../core/workspace.ts';

// No Git, update-check, baseline, receipt or storage calls are available here.
test('live installed sources follow native source moves without inspecting or changing code/history', async () => {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), 'pa-live-sources-')));
  const logs: string[] = [];
  let plugin = { id: 'google-drive', version: '0.1.1', enabled: true, rootDir: '/managed/plugins/google-drive' };
  let source: { requested: string; resolved: string; subdirectory?: string } = { requested: `git:${originUrl}@main`, resolved: `${originUrl} (${'a'.repeat(40)})`, subdirectory: 'plugins/google-drive' };
  let failSource = false, failList = false;
  const bb = { log: { warn: (message: string) => logs.push(message) }, sdk: { plugins: {
    list: async () => { if (failList) throw new Error('PRIVATE_SENTINEL account token'); return { plugins: [plugin] }; },
    getSource: async () => { if (failSource) throw new Error('PRIVATE_SENTINEL provider body'); return source; },
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb, originUrl, async () => checkout);
  try {
    const first = (await ports.installedSources!())[0];
    assert.deepEqual(first, { id: 'google-drive', installed: '0.1.1', sourceEnabled: true, sourceMode: 'managed', sourceGeneration: sourceGeneration(plugin, source) });
    const local = join(checkout, 'plugins/google-drive'); await mkdir(local, { recursive: true });
    plugin = { ...plugin, rootDir: local }; source = { requested: `path:${local}`, resolved: local, subdirectory: undefined };
    const moved = (await ports.installedSources!())[0];
    assert.equal(moved.sourceMode, 'local'); assert.notEqual(moved.sourceGeneration, first.sourceGeneration);
    plugin.enabled = false;
    const disabled = (await ports.installedSources!())[0];
    assert.equal(disabled.sourceEnabled, false); assert.notEqual(disabled.sourceGeneration, moved.sourceGeneration);
    source.requested = 'npm:unrelated@1.0.0';
    assert.equal((await ports.installedSources!())[0].sourceMode, 'unsupported');
    source.requested = `path:${checkout}/other`; // Not the standard working folder.
    assert.equal((await ports.installedSources!())[0].sourceMode, 'unsupported');
    failSource = true;
    assert.deepEqual((await ports.installedSources!())[0], { id: 'google-drive', installed: '0.1.1', sourceEnabled: false, sourceMode: null, sourceGeneration: null });
    await ports.installedSources!(); // Repeated polling does not flood diagnostics.
    failList = true;
    await assert.rejects(ports.installedSources!(), /^Error: Installed sources unavailable/);
    await assert.rejects(ports.installedSources!(), /^Error: Installed sources unavailable/);
    assert.deepEqual(logs, ['pa-updates stage=installed-sources outcome=source_unavailable', 'pa-updates stage=installed-sources outcome=unavailable']);
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_SENTINEL'));
  } finally { await ports.cancel?.(); await rm(checkout, { recursive: true, force: true }); }
});
