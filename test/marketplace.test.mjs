import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../marketplace.json', import.meta.url);

test('marketplace catalog is v2 and does not advertise the packaging spike', async () => {
  const catalog = JSON.parse(await readFile(root, 'utf8'));
  assert.equal(catalog.$schema, 'https://getbb.app/schemas/marketplace-v2.schema.json');
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.name, 'pa-for-bb');
  assert.deepEqual(catalog.plugins, []);
});
