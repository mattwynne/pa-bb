import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../marketplace.json', import.meta.url);

test('marketplace catalog is v2 and lists only the standalone Calendar plugin', async () => {
  const catalog = JSON.parse(await readFile(root, 'utf8'));
  assert.equal(catalog.$schema, 'https://getbb.app/schemas/marketplace-v2.schema.json');
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.name, 'pa-for-bb');
  assert.deepEqual(catalog.plugins.map(plugin => plugin.id), ['google-calendar']);
  assert.equal(catalog.plugins[0].source.git.subdir, 'plugins/google-calendar');
  assert.equal(catalog.plugins[0].source.git.url, 'https://github.com/mattwynne/pa-bb.git');
  const plugin = JSON.parse(await readFile(new URL('../plugins/google-calendar/package.json', import.meta.url), 'utf8'));
  assert.equal(plugin.name, 'bb-plugin-google-calendar');
  assert.equal(plugin.bb.server, './server.ts');
});
