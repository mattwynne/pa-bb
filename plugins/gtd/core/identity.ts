import { z } from 'zod';

const uuid4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const stableIds = {
  project: z.string().regex(new RegExp(`^project_${uuid4}$`)),
  area: z.string().regex(new RegExp(`^area_${uuid4}$`)),
};
export type Kind = keyof typeof stableIds;
export type IdentityScope = { vaultId: string; projectsFolder: string; areasFolder: string };
export const scopeKey = ({vaultId, projectsFolder, areasFolder}: IdentityScope) =>
  JSON.stringify([vaultId, projectsFolder, areasFolder]);
export const aliasSchema = z.object({ kind: z.enum(['project', 'area']), from: z.string(), to: z.string() }).strict();
export type Alias = z.infer<typeof aliasSchema>;
