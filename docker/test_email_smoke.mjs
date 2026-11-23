import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsHost } from './email-smoke.mjs';

test('Email requires the plugin-declared stable BB minimum, not just a registered plugin', () => {
  for (const version of ['0.50.1', '0.50.2', '0.51.0', '1.0.0']) {
    assert.equal(supportsHost(version, '>=0.50.1'), true, version);
  }
  for (const version of ['0.49.0', '0.50.0', '0.50.1-beta.1', 'invalid', undefined, null]) {
    assert.equal(supportsHost(version, '>=0.50.1'), false, String(version));
  }
});

test('unknown version ranges and invalid version fields fail closed', () => {
  for (const range of ['*', '^0.50.1', '>=0.50.1 <1', undefined, null]) {
    assert.equal(supportsHost('0.50.1', range), false);
  }
  assert.equal(supportsHost('9007199254740993.0.0', '>=0.50.1'), false);
  assert.equal(supportsHost('0.50.1', '>=9007199254740993.0.0'), false);
});
