import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('plugin and marketplace use BB’s supported Calendar glyph', () => {
  const plugin = json('../package.json');
  const marketplace = json('../../../marketplace.json');
  assert.equal(plugin.bb.branding.icon, 'Calendar');
  assert.equal(marketplace.plugins.find(entry => entry.id === 'google-calendar')?.icon, 'Calendar');
});
