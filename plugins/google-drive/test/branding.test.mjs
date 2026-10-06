import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('plugin and marketplace use a folder glyph instead of a physical-drive glyph', () => {
  const plugin = json('../package.json');
  const marketplace = json('../../../marketplace.json');
  assert.equal(plugin.bb.branding.icon, 'FolderOpen');
  assert.equal(marketplace.plugins.find(entry => entry.id === 'google-drive')?.icon, 'FolderOpen');
});
