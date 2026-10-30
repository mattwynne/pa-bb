// Narrow ZIP32 reader for import inspection. Never trusts declared expanded
// sizes for decompression, extracts files, or accepts ambiguous header layouts.
import { inflateRawSync, crc32 } from 'node:zlib';
import { uploadError } from '../core/upload.mjs';
const ENTRY = 4 * 1024 * 1024, TOTAL = 16 * 1024 * 1024;
export function readXlsxZip(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw uploadError('conversion');
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
      if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
    }
    if (end === -1 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw uploadError('conversion');
    const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
    if (!count || count > 512 || count !== bytes.readUInt16LE(end + 8) || centralStart + centralSize !== end) throw uploadError('conversion');
    const files = Object.create(null), entries = []; let cursor = centralStart, total = 0;
    const text = b => new TextDecoder('utf-8', { fatal: true }).decode(b);
    function extras(start, length) {
      const last = start + length;
      for (let p = start; p < last;) { if (p + 4 > last || ![0x5455, 0x000a].includes(bytes.readUInt16LE(p))) throw uploadError('conversion'); const size = bytes.readUInt16LE(p + 2); p += 4 + size; if (p > last) throw uploadError('conversion'); }
    }
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw uploadError('conversion');
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > end || flags & ~0x800 || ![0, 8].includes(method) || size > ENTRY || (total += size) > TOTAL || bytes.readUInt16LE(cursor + 34)) throw uploadError('conversion');
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = text(nameBytes);
      if (!name || /[^\x20-\x7e]/.test(name) || Object.hasOwn(files, name) || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.') || /[\p{Cc}\p{Cs}]/u.test(name)
        || /(?:vba|macro|externalLink|connection|embedding|activeX|customUI|queryTable)/i.test(name)) throw uploadError('conversion');
      extras(cursor + 46 + nameLength, extraLength);
      if (offset + 30 > centralStart || bytes.readUInt32LE(offset) !== 0x04034b50
        || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt32LE(offset + 14) !== crc
        || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== size
        || bytes.readUInt16LE(offset + 26) !== nameLength) throw uploadError('conversion');
      const localExtra = bytes.readUInt16LE(offset + 28), start = offset + 30 + nameLength + localExtra, stop = start + compressed;
      if (stop > centralStart || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(nameBytes)) throw uploadError('conversion');
      extras(offset + 30 + nameLength, localExtra);
      let content;
      if (method === 0) content = bytes.subarray(start, stop);
      else {
        // maxOutputLength bounds ACTUAL inflation, independent of forged ZIP
        // size fields. info also rejects trailing compressed-stream junk.
        const inflated = inflateRawSync(bytes.subarray(start, stop), { maxOutputLength: ENTRY, info: true });
        if (inflated.engine.bytesWritten !== compressed) throw uploadError('conversion');
        content = inflated.buffer;
      }
      if (content.length !== size || crc32(content) !== crc) throw uploadError('conversion');
      files[name] = content; entries.push([offset, stop]); cursor = next;
    }
    if (cursor !== end) throw uploadError('conversion');
    entries.sort((a, b) => a[0] - b[0]);
    if (entries[0][0] !== 0 || entries.at(-1)[1] !== centralStart || entries.some((p, i) => i && p[0] !== entries[i - 1][1])) throw uploadError('conversion');
    return files;
  } catch { throw uploadError('conversion'); }
}
