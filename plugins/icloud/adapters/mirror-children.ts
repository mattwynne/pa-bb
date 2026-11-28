import { constants } from 'node:fs';
import { open, opendir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

/** Immediate children only, under MirrorRuntime.access admission. No raw roots leave iCloud. */
export async function mirrorChildren(root: string, folder: string, signal?: AbortSignal) {
  const entries: Array<{ name: string; kind: 'directory' | 'file' }> = [];
  let incomplete = false, seen = 0, bytes = 0;
  const started = Date.now(), handles: FileHandle[] = [];
  const cancelled = () => { if (signal?.aborted) throw new Error('cancelled'); };
  if (!folder || folder.length > 1024 || /[\\\x00-\x1f\x7f]/.test(folder) || folder.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid_path');
  try {
    cancelled();
    let path = root;
    for (const part of ['', ...folder.split('/')]) {
      const handle = await open(part ? join(path, part) : path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle); path = `/proc/self/fd/${handle.fd}`; cancelled();
    }
    const directory = await opendir(path);
    try {
      for await (const child of directory) {
        cancelled();
        if (++seen > 5000 || Date.now() - started > 2000) { incomplete = true; break; }
        if (child.isSymbolicLink()) { incomplete = true; continue; }
        const kind = child.isDirectory() ? 'directory' : child.isFile() ? 'file' : null;
        if (!kind) continue;
        if (/[\\\x00-\x1f\x7f]/.test(child.name) || Buffer.byteLength(child.name) > 1024 || folder.length + child.name.length + 1 > 1024) { incomplete = true; continue; }
        const entry: { name: string; kind: 'directory' | 'file' } = { name: child.name, kind };
        bytes += Buffer.byteLength(JSON.stringify(entry));
        if (bytes > 512 * 1024) { incomplete = true; break; }
        entries.push(entry);
      }
    } finally { await directory.close().catch(() => {}); }
  } catch { incomplete = true; }
  finally { await Promise.all(handles.reverse().map(handle => handle.close())); }
  return { entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'en')), incomplete };
}
