import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
test('marketplace validates and lists only independently installable current plugins', async () => {
  const schema = await load('../../../docs/references/bb-marketplace-v2.schema.json');
  const catalog = await load('../../../marketplace.json');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.ok(validate(catalog), JSON.stringify(validate.errors));
  assert.deepEqual(catalog.plugins.map(p => p.id).sort(), ['email', 'fastmail', 'google-workspace', 'icloud', 'obsidian']);
  for (const entry of catalog.plugins) {
    assert.equal(entry.source.git.url, 'https://github.com/mattwynne/pa-bb.git');
    assert.equal(entry.source.git.subdir, `plugins/${entry.id}`);
    const pkg = await load(`../../../${entry.source.git.subdir}/package.json`);
    assert.equal(pkg.name, `bb-plugin-${entry.id}`);
    assert.equal(entry.icon, pkg.bb.branding.icon);
    assert.ok(pkg.bb.server && pkg.bb.app);
  }
  for (const retired of ['google-calendar', 'google-drive', 'pa-updates']) {
    await assert.rejects(access(new URL(`../../${retired}/package.json`, import.meta.url)), { code: 'ENOENT' });
  }
});
