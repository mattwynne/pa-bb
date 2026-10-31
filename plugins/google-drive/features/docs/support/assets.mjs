// DNS/HTTPS are distinct injected ports. This file never invokes global fetch.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createImageAssets } from '../../../adapters/image-asset.mjs';
const fixture = JSON.parse(readFileSync(new URL('../coverage/fixtures/asset.json', import.meta.url)));
export function assetBoundary(fault = 'none') {
  const calls = [], unexpected = [];
  const fail = message => { unexpected.push(message); throw new Error(message); };
  const contract = (port, fn) => {
    const count = unexpected.length;
    try { return fn(); } catch (error) { if (unexpected.length === count) unexpected.push(`${port} contract`); throw error; }
  };
  const assets = createImageAssets({
    resolve: async (hostname, options) => contract('DNS', () => {
      calls.push('dns'); if (hostname !== 'art.example.test') fail('unexpected DNS');
      assert.deepEqual(options, { all: fault !== 'dnsContract', family: 4 });
      return [{ address: fault === 'private' ? '127.0.0.1' : '8.8.8.8', family: 4 }];
    }),
    request: (url, options, callback) => contract('HTTPS', () => {
      calls.push('https'); if (url.href !== 'https://art.example.test/red.png') fail('unexpected HTTPS');
      assert.equal(options.method, fault === 'httpsContract' ? 'POST' : 'GET'); assert.equal(options.agent, false);
      assert.deepEqual(options.headers, { accept: 'image/png', 'accept-encoding': 'identity' });
      options.lookup('art.example.test', {}, (err, address, family) => { assert.equal(err, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const response = new PassThrough(); response.statusCode = fault === 'redirect' ? 302 : 200;
        response.headers = { 'content-type': 'image/png', ...(fault === 'oversize' ? { 'content-length': '2097153' } : {}) };
        callback(response);
        response.end(fault === 'corrupt' ? Buffer.from('PRIVATE_INVALID_IMAGE') : Buffer.from(fixture.base64,'base64'));
      }); return req;
    })
  });
  return { assets, calls, unexpected, expected: fixture.expected,
    check: () => assert.deepEqual(unexpected, [], 'unacknowledged asset fixture fault'),
    acknowledge: expected => { assert.deepEqual(unexpected, [expected], 'only the exact asserted asset fault may be acknowledged'); unexpected.shift(); }
  };
}
