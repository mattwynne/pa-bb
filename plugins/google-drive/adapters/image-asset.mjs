// Public artwork only. No credentials, proxy, redirects, converter or hosting.
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { imageError } from '../core/docs-image.mjs';
const MAX_BYTES = 2 * 1024 * 1024, MAX_PIXELS = 4_000_000;
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip, prefix, 'ipv4');
export const publicV4 = address => isIP(address) === 4 && !blocked.check(address, 'ipv4');
export function imageUrl(input) {
  let u; try { u = new URL(input); } catch { throw imageError('asset'); }
  if (typeof input !== 'string' || input.length > 2000 || u.href !== input || u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname) || isIP(u.hostname)) throw imageError('asset');
  return u;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function pngCrc(bytes) { let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
export function inspectPng(bytes, mime) {
  const fail = () => { throw imageError('asset'); };
  if (mime !== 'image/png' || !Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail();
  let offset = 8, width, height, channels, header = false, end = false, dataEnded = false, sawData = false;
  const parts = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail();
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8), stop = offset + 12 + length;
    if (stop > bytes.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || pngCrc(bytes.subarray(offset + 4, stop - 4)) !== bytes.readUInt32BE(stop - 4)) fail();
    const data = bytes.subarray(offset + 8, stop - 4);
    if (!header && type !== 'IHDR') fail();
    if (type === 'IHDR') {
      if (header || length !== 13) fail();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS || data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail();
      header = true;
    } else if (type === 'IDAT') { if (dataEnded) fail(); sawData = true; parts.push(data); }
    else if (type === 'IEND') { if (length || !sawData || stop !== bytes.length) fail(); end = true; }
    else {
      if (sawData) dataEnded = true;
      // Never accept APNG. Unknown critical chunks/ancillary payloads are refused.
      // Reject metadata with its own compression stream (including all iTXt),
      // rather than delegating unbounded ancillary inflation to a downstream decoder.
      if (!['sRGB','gAMA','cHRM','pHYs','tEXt','bKGD','sBIT','tIME','tRNS','PLTE'].includes(type)) fail();
      if (type === 'PLTE' && (sawData || !length || length % 3 || length > 768)) fail();
    }
    offset = stop;
  }
  if (!end) fail();
  const stride = width * channels + 1, expected = stride * height;
  let raw; try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected }); } catch { fail(); }
  if (raw.length !== expected) fail();
  for (let row = 0; row < height; row++) if (raw[row * stride] > 4) fail();
  return { mimeType: 'image/png', bytes: bytes.length, width, height, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function createImageAssets({ resolve = lookup, request = https.request } = {}) {
  return { async inspect(uri, signal) {
    const u = imageUrl(uri), timeout = AbortSignal.timeout(10000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    // Resolve all IPv4 answers and fail closed on any non-public address; pin the
    // selected address into the TLS connection to prevent DNS-rebinding TOCTOU.
    let onAbort;
    let addresses;
    try {
      addresses = await Promise.race([resolve(u.hostname, { all: true, family: 4 }), new Promise((_, reject) => {
        onAbort = () => reject(imageError('asset'));
        combined.addEventListener('abort', onAbort, { once: true });
      })]);
    } finally { if (onAbort) combined.removeEventListener('abort', onAbort); }
    combined.throwIfAborted();
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(a => a.family !== 4 || !publicV4(a.address))) throw imageError('asset');
    const result = await new Promise((resolveResult, reject) => {
      const req = request(u, { method: 'GET', agent: false, family: 4, signal: combined,
        headers: { accept: 'image/png', 'accept-encoding': 'identity' },
        lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
      }, response => {
        const fail = () => { response.destroy(); req.destroy(); reject(imageError('asset')); };
        const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (response.statusCode !== 200 || mime !== 'image/png' || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') || Number(response.headers['content-length']) > MAX_BYTES) { fail(); return; }
        const chunks = []; let size = 0;
        response.on('error', () => reject(imageError('asset')));
        response.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) fail(); else chunks.push(chunk); });
        response.on('end', () => { try { resolveResult(inspectPng(Buffer.concat(chunks), mime)); } catch { reject(imageError('asset')); } });
      });
      req.on('error', () => reject(imageError('asset'))); req.end();
    });
    return result;
  } };
}
