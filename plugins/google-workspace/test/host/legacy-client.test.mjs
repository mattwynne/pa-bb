import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

for (const source of ['google-drive', 'google-calendar']) {
  test(`${source}: only Workspace's verified plugin caller can copy the Web client; no tokens exported`, async () => {
    const plugin = (await import(`../../../${source}/dist/server.js`)).default;
    // These existing plugins target a newer SDK than Workspace's minimum-host proof.
    const require = createRequire(new URL(`../../../${source}/package.json`, import.meta.url));
    const { createFakePluginHost } = await import(require.resolve('@get-bb/plugin-sdk/testing'));
    const host = createFakePluginHost({ pluginId: source, appUrl: 'https://bb.example', settings: { clientId: 'existing-client', clientSecret: 'SECRET_CLIENT' } });
    try {
      await plugin(host.bb);
      await assert.rejects(host.harness.behavior.callRpc('exportOAuthClientForWorkspace', null));
      await assert.rejects(host.harness.behavior.callRpc('exportOAuthClientForWorkspace', null, { experimental_caller: { kind: 'plugin', pluginId: 'unrelated-plugin' } }));
      const result = await host.harness.behavior.callRpc('exportOAuthClientForWorkspace', null, { experimental_caller: { kind: 'plugin', pluginId: 'google-workspace' } });
      assert.deepEqual(result, { clientId: 'existing-client', clientSecret: 'SECRET_CLIENT' });
      assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /SECRET_CLIENT/);
    } finally { await host.harness.lifecycle.dispose(); }
  });
}
