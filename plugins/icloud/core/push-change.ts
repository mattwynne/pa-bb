import { z } from 'zod';

const relative = z.string().min(1).max(1024).refine(path => !/[\\\x00-\x1f\x7f]/.test(path) &&
  path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'));
// A change Obsidian has already applied to the local mirror.
export const pushChangeSchema = z.object({
  mirrorId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('write'), path: relative }).strict(),
    z.object({ kind: z.literal('move'), path: relative, destination: relative, directory: z.literal(true).optional() }).strict(),
  ]),
}).strict();
export type PushChange = z.infer<typeof pushChangeSchema>['change'];
