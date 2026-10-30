// Local Linux only. The root comes from the public BB thread-storage API, not
// private state. Walk pinned directory descriptors with NOFOLLOW; no glob/list,
// remote host, URL, archive extraction, or path-selected root is supported.
import { open, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES, uploadError } from '../core/upload.mjs';
import { inspectXlsx } from './xlsx-import.mjs';
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const revision = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
export function createUploadSource({ location, platform = process.platform }) {
  return { async capture(source, expectedSha256, mode) {
    const handles = [];
    try {
      if (platform !== 'linux' || source.host !== 'bb-server' || !/^thr_[a-z0-9]+$/.test(source.threadId)) throw uploadError('source');
      const parts = source.path.split('/');
      if (parts.some(p => !p || p.startsWith('.') || p.includes('\\') || /[\p{Cc}\p{Cs}]/u.test(p)
        || /(?:^|[._-])(?:credentials?|secrets?|tokens?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(p))
        || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(parts.at(-1))) throw uploadError('source');
      const root = await location(source.threadId);
      if (!posix.isAbsolute(root) || posix.normalize(root) !== root || root === '/' || root.startsWith('/proc/') || root.startsWith('/dev/') || root.startsWith('/sys/')) throw uploadError('source');
      let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(current);
      for (const segment of [...root.split('/').filter(Boolean), ...parts.slice(0, -1)]) {
        current = await open(`/proc/self/fd/${current.fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(current);
      }
      const file = await open(`/proc/self/fd/${current.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(file);
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_UPLOAD_BYTES)) throw uploadError('source');
      const absolute = posix.join(root, source.path);
      if (await readlink(`/proc/self/fd/${file.fd}`) !== absolute) throw uploadError('source');
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) { const r = await file.read(bytes, offset, bytes.length - offset, offset); if (!r.bytesRead) throw uploadError('changed'); offset += r.bytesRead; }
      const after = await file.stat({ bigint: true });
      if (revision(before) !== revision(after) || await readlink(`/proc/self/fd/${file.fd}`) !== absolute) throw uploadError('changed');
      const sha256 = digest('sha256', bytes);
      if (sha256 !== expectedSha256) throw uploadError('changed');
      const conversion = mode === 'xlsx_to_sheet' ? inspectXlsx(bytes, parts.at(-1)) : undefined;
      return { bytes, sha256, md5: digest('md5', bytes), sizeBytes: bytes.length, name: parts.at(-1), location: absolute,
        version: digest('sha256', `${root}:${source.path}:${revision(after)}:${sha256}`), conversion };
    } catch (e) { if (e?.uploadCode) throw e; throw uploadError('source'); }
    finally { for (const h of handles.reverse()) await h.close().catch(() => {}); }
  } };
}
