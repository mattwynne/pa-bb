import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { createImageAssets, imageUrl, publicV4, inspectPng, pngCrc } from '../adapters/image-asset.mjs';
export function chunk(type, data) { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(pngCrc(b.subarray(4, b.length - 4)), b.length - 4); return b; }
export function png(width = 2, height = 1, options = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = options.depth ?? 8; header[9] = options.color ?? 6; header[12] = options.interlace ?? 0;
  const data = options.raw || Buffer.alloc((width * (header[9] === 2 ? 3 : 4) + 1) * height);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...(options.chunks || []), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
const uri = 'https://example.test/logo.png';
test('canonical public HTTPS URLs only; no executable/private/credential/query/redirect tricks', () => {
  assert.equal(imageUrl(uri).hostname, 'example.test');
  for (const s of ['http://example.test/logo.png','https://localhost/logo.png','https://127.0.0.1/logo.png','https://[::1]/x','https://user:pass@example.test/x','https://example.test/logo.png?token=SECRET','https://example.test/x#fragment','https://EXAMPLE.test/x','https://example.test:8443/x','file:///etc/passwd','data:image/png;base64,abc','https://example.test/../private','https://example.test\\@127.0.0.1/x']) assert.throws(() => imageUrl(s), /PNG URL/);
  for (const ip of ['127.0.0.1','10.1.2.3','100.64.1.1','169.254.169.254','172.16.1.1','192.168.1.1','0.0.0.0','198.18.1.1','224.1.1.1','255.255.255.255','::1','::ffff:127.0.0.1','203.0.113.1']) assert.equal(publicV4(ip), false, ip);
  assert.equal(publicV4('8.8.8.8'), true);
});
test('PNG signature, MIME, CRC, pixel/byte/decoder bounds and unsupported SVG/APNG/interlace are checked', () => {
  const b = png(); assert.deepEqual({ ...inspectPng(b, 'image/png'), sha256: null }, { mimeType: 'image/png', bytes: b.length, width: 2, height: 1, sha256: null });
  for (const [bytes, mime] of [[Buffer.from('<svg><script>PRIVATE</script></svg>'),'image/png'],[b,'image/svg+xml'],[b,'image/jpeg'],[png(2,1,{depth:16}),'image/png'],[png(2,1,{color:3}),'image/png'],[png(2,1,{interlace:1}),'image/png'],[png(2,1,{chunks:[chunk('acTL',Buffer.alloc(8))]}),'image/png'],[Buffer.concat([b,Buffer.from('trailing')]),'image/png'],[b.subarray(0,b.length-1),'image/png'],[png(2,1,{raw:Buffer.alloc(100000)}),'image/png'],[Buffer.alloc(2097153),'image/png']]) assert.throws(() => inspectPng(bytes,mime));
  for (const type of ['zTXt', 'iCCP', 'iTXt']) assert.throws(() => inspectPng(png(1,1,{chunks:[chunk(type,Buffer.concat([Buffer.from('metadata\u0000\u0000'),deflateSync(Buffer.alloc(20*1024*1024))]))]}),'image/png'));
  const highBit = Buffer.from(b); highBit[12] |= 0x80; highBit.writeUInt32BE(pngCrc(highBit.subarray(12,29)),29); assert.throws(() => inspectPng(highBit,'image/png'));
  const corrupt = Buffer.from(b); corrupt[40] ^= 1; assert.throws(() => inspectPng(corrupt, 'image/png'));
  const huge = Buffer.from(b); huge.writeUInt32BE(8193,16); huge.writeUInt32BE(pngCrc(huge.subarray(12,29)),29); assert.throws(() => inspectPng(huge,'image/png'));
  assert.throws(() => inspectPng(png(2,1,{raw:Buffer.from([5,0,0,0,0,0,0,0,0])}), 'image/png'));
});
function requestFake({ status = 200, mime = 'image/png', body = png(), length, encoding } = {}, inspectOptions = () => {}) {
  return (url, options, callback) => {
    inspectOptions(url, options);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = status; response.headers = { 'content-type': mime, ...(length ? { 'content-length': String(length) } : {}), ...(encoding ? { 'content-encoding': encoding } : {}) };
      callback(response); if (!response.destroyed) response.end(body);
    }); return req;
  };
}
test('adapter pins validated DNS address, sends no credentials and refuses redirects/MIME/bytes/private mixed DNS', async () => {
  let requests = 0;
  const resolve = async (name, options) => { assert.equal(name,'example.test'); assert.deepEqual(options,{all:true,family:4}); return [{ address:'8.8.8.8',family:4 }]; };
  const request = requestFake({}, (_url, opts) => {
    requests++; assert.equal(opts.agent,false); assert.deepEqual(opts.headers,{accept:'image/png','accept-encoding':'identity'}); assert.equal(opts.signal.aborted,false);
    opts.lookup('example.test',{},(_error,address,family) => { assert.equal(address,'8.8.8.8'); assert.equal(family,4); });
  });
  const asset = await createImageAssets({resolve,request}).inspect(uri); assert.equal(asset.width,2); assert.equal(requests,1);
  for (const fixture of [{status:302},{status:401},{mime:'image/svg+xml'},{body:Buffer.from('<svg/>')},{length:2097153},{body:Buffer.alloc(2097153)},{encoding:'gzip'}]) await assert.rejects(() => createImageAssets({ resolve,request:requestFake(fixture) }).inspect(uri));
  for (const addresses of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'::1',family:6}],[]]) await assert.rejects(() => createImageAssets({resolve:async()=>addresses, request:()=>{ throw new Error('MUST_NOT_FETCH'); }}).inspect(uri));
});
test('caller abort during DNS blocks the request without leaking raw resolver/transport error', async () => {
  const c = new AbortController();
  const work = createImageAssets({ resolve:async()=>new Promise(()=>{}),request:()=>{throw new Error('MUST_NOT_FETCH');} }).inspect(uri,c.signal);
  c.abort(); await assert.rejects(work, /PNG URL/);
});
