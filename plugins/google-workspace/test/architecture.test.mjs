import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

test('core depends only on core modules and pure crypto, not adapters or systems', async () => {
  const dir = new URL('../core/', import.meta.url);
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.mjs'))) {
    const source = await readFile(new URL(name, dir), 'utf8');
    for (const [, dependency] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      assert.ok(dependency.startsWith('./') || dependency === 'node:crypto', `${name} imports ${dependency}`);
    }
    assert.doesNotMatch(source, /\b(?:fetch|setTimeout|spawn)\s*\(/);
  }
});
