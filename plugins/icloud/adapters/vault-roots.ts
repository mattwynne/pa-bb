import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';

/** Called only inside NoteRuntime.access: pinned, no-follow directory traversal. */
export async function vaultRoots(root: string) {
  const roots: string[] = []; let entries = 0, incomplete = false;
  const started = Date.now();
  async function walk(path: string, relative: string, depth: number) {
    if (depth > 32 || entries > 10000 || Date.now() - started > 2000 || roots.length >= 100) { incomplete = true; return; }
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = `/proc/self/fd/${handle.fd}`;
      try {
        const marker = await open(join(pinned, '.obsidian'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await marker.close(); roots.push(relative); return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; }
      const dir = await opendir(pinned);
      try { for await (const child of dir) {
        if (++entries > 10000 || Date.now() - started > 2000) { incomplete = true; break; }
        if (child.isDirectory() && !['.obsidian', '.git', 'node_modules'].includes(child.name)) {
          // Keep the relative spelling separate from the pinned parent path.
          await walk(join(pinned, child.name), relative ? relative + '/' + child.name : child.name, depth + 1);
        }
      } } finally { await dir.close().catch(() => {}); }
    } finally { await handle.close(); }
  }
  try { await walk(root, '', 0); } catch { incomplete = true; }
  return { roots: roots.sort(), incomplete };
}
