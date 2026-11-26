import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(1024).refine(value =>
  !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
export const folderMoveEntry = z.discriminatedUnion('kind', [
  z.object({ path: relative, kind: z.literal('directory') }).strict(),
  z.object({ path: relative, kind: z.literal('file'), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), hash }).strict(),
]);
export type FolderMoveEntry = z.infer<typeof folderMoveEntry>;
export const folderManifestLimit = 10_000;
export const folderManifestPageLimit = 64;

export const folderMoveManifest = z.object({
  fingerprint: hash,
  entries: z.array(folderMoveEntry).max(folderManifestLimit),
}).strict();

export const folderMoveEvidence = z.object({
  source: folderMoveManifest,
  destination: folderMoveManifest.optional(),
}).strict();

export type FolderMoveManifest = z.infer<typeof folderMoveManifest>;
