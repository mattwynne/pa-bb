import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateFilePath } from './file-store.ts';

/** Called only inside MirrorRuntime.access: pinned, no-follow directory traversal. */
export async function findDirectories(root: string, markerName: string, exclude: readonly string[], signal?: AbortSignal) {
  validateFilePath(markerName);
  if (markerName.includes('/')) throw new Error('invalid_path');
  const directories: string[] = []; let entries = 0, incomplete = false;
  const started = Date.now();
  async function walk(path: string, relative: string, depth: number) {
    if (signal?.aborted || depth > 32 || relative.length > 1024 || entries > 10000 || Date.now() - started > 2000 || directories.length >= 100) { incomplete = true; return; }
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = `/proc/self/fd/${handle.fd}`;
      try {
        const marker = await open(join(pinned, markerName), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await marker.close(); directories.push(relative); return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; }
      const dir = await opendir(pinned);
      try { for await (const child of dir) {
        if (signal?.aborted || ++entries > 10000 || Date.now() - started > 2000) { incomplete = true; break; }
        if (child.isDirectory() && child.name !== markerName && !exclude.includes(child.name)) {
          // Keep the relative spelling separate from the pinned parent path.
          await walk(join(pinned, child.name), relative ? relative + '/' + child.name : child.name, depth + 1);
        }
      } } finally { await dir.close().catch(() => {}); }
    } finally { await handle.close(); }
  }
  try { await walk(root, '', 0); } catch { incomplete = true; }
  return { directories: directories.sort(), incomplete };
}
