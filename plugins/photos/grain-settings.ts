import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PhotosError } from './errors.ts';
import { grainConfiguration } from './grain.ts';
import type { GrainConfiguration } from './grain.ts';

export interface StoredSetting<T> {
  get(): Promise<T | null>;
  set(value: T | null): Promise<void>;
}
export type GrainSettings = StoredSetting<GrainConfiguration>;

// The group that Journal galleries are shared with. The DID is optional until
// posting can resolve it from the handle.
export const grainGroup = z.object({
  handle: z.string().trim().toLowerCase().max(253)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/),
  did: z.string().trim().max(2048).regex(/^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%:-]+)$/).nullable(),
}).strict();
export type GrainGroup = z.infer<typeof grainGroup>;

/** A small owner-only JSON file in a private directory, replaced atomically. */
export function secureSettingFile<T>(root: string, name: string, schema: z.ZodType<T>): StoredSetting<T> {
  const path = join(root, name);
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
          return schema.parse(JSON.parse(await file.readFile('utf8')));
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

export function grainSettingsFile(root: string): GrainSettings {
  return secureSettingFile(root, 'connection.json', grainConfiguration);
}
export function groupSettingsFile(root: string): StoredSetting<GrainGroup> {
  return secureSettingFile(root, 'group.json', grainGroup);
}
