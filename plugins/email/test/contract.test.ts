import assert from 'node:assert/strict';
import test from 'node:test';
import { message } from '../contract.ts';

test('archive response validates multi-megabyte Base64 MIME', () => {
  const mime = Buffer.alloc(4 * 1024 * 1024, 0x2f).toString('base64');
  assert.ok(message.safeParse({ status: 'ok', mime }).success);
  assert.equal(message.safeParse({ status: 'ok', mime: mime.slice(0, -1) + '!' }).success, false);
});

test('archive response allows up to two trailing padding characters', () => {
  for (const mime of ['AZaz09+/', 'YWI=', 'YQ==']) {
    assert.ok(message.safeParse({ status: 'ok', mime }).success);
  }
  for (const mime of ['', '=', 'AA===', 'A=BC', 'AAAA\n', '____']) {
    assert.equal(message.safeParse({ status: 'ok', mime }).success, false, JSON.stringify(mime));
  }
});
