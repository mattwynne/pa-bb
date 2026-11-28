import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PhotosError } from './errors.ts';
import { grainConfiguration } from './grain.ts';
import type { GrainConfiguration } from './grain.ts';

export interface GrainSettings {
  get(): Promise<GrainConfiguration | null>;
  set(value: GrainConfiguration | null): Promise<void>;
}

export function grainSettingsFile(root: string): GrainSettings {
  const path = join(root, 'connection.json');
  async function secureRoot() {
    const info = await lstat(root);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new PhotosError('storage');
  }
  return {
    async get() {
      try {
        await secureRoot();
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 8192) throw new PhotosError('storage');
          return grainConfiguration.parse(JSON.parse(await file.readFile('utf8')));
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new PhotosError('storage');
      }
    },
    async set(value) {
      if (!value) {
        try { await secureRoot(); await rm(path, { force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PhotosError('storage'); }
        return;
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      await secureRoot();
      const staging = join(root, randomUUID());
      try {
        await writeFile(staging, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
        await rename(staging, path);
      } finally { await rm(staging, { force: true }); }
    },
  };
}
