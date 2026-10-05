import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
test('the Git marketplace catalog passes BB v2 schema and targets this plugin package', async () => {
  const schema = await load('../../../docs/references/bb-marketplace-v2.schema.json');
  const catalog = await load('../../../marketplace.json');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.ok(validate(catalog), JSON.stringify(validate.errors));
  const [entry] = catalog.plugins;
  assert.equal(catalog.plugins.length, 1);
  assert.equal(entry.id, 'google-calendar');
  assert.equal(entry.source.git.subdir, 'plugins/google-calendar');
  assert.equal(entry.source.git.url, 'https://github.com/mattwynne/pa-bb.git');
});
