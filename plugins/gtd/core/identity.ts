import { z } from 'zod';

const uuid4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export type Kind = 'project' | 'area';
const idSchema = (kind: Kind, separator: '-' | '[-_]') =>
  z.string().regex(new RegExp(`^${kind}${separator}${uuid4}$`));
export const canonicalIds = {
  project: idSchema('project', '-'),
  area: idSchema('area', '-'),
};
// Assigned IDs are immutable, including those issued before the separator changed.
export const stableIds = {
  project: idSchema('project', '[-_]'),
  area: idSchema('area', '[-_]'),
};
export const newStableId = (kind: Kind) => `${kind}-${globalThis.crypto.randomUUID()}`;
export type IdentityScope = { vaultId: string; projectsFolder: string; areasFolder: string };
export const scopeKey = ({vaultId, projectsFolder, areasFolder}: IdentityScope) =>
  JSON.stringify([vaultId, projectsFolder, areasFolder]);
export const aliasSchema = z.object({ kind: z.enum(['project', 'area']), from: z.string(), to: z.string() }).strict();
export type Alias = z.infer<typeof aliasSchema>;
