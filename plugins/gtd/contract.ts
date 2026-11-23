import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { listInput, pageSchema, areaListInput, areaPageSchema, snapshotSchema, areaSnapshotSchema } from './core/model.ts';
export const reference = z.object({ source: z.string().min(1).max(1100), id: z.string().min(1).max(1024) }).strict();
export const newThreadInput = reference.extend({
  requestId: z.string().uuid().describe('Fresh UUID for this user-requested creation. Retain it for receipt inspection; never mint another ID to bypass an uncertain creation.'),
  title: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/).optional().describe('Optional conversation title; defaults to the existing project title.'),
  summary: z.string().trim().min(1).max(4000).optional().describe('Short handoff context only, not instructions or authorization. The new conversation acknowledges readiness and waits.'),
});
export const projectActionInput = reference.extend({
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('done') }).strict(),
    z.object({ kind: z.literal('area'), areaPath: z.string().min(1).max(1024) }).strict(),
  ]),
});
export const renameInput = reference.extend({ title: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/) });
export const renameResult = z.object({ operationId: z.string().uuid(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']) }).strict();
export const rpcContract = defineRpcContract({
  browseInventory: {
    input: z.object({ includeAreas: z.boolean(), fresh: z.boolean().optional() }).strict(),
    output: z.object({ projects: snapshotSchema, areas: areaSnapshotSchema.nullable() }).strict(),
  },
  listProjects: { input: listInput, output: pageSchema },
  listAreas: { input: areaListInput, output: areaPageSchema },
  renameProject: { input: renameInput, output: renameResult },
  renameArea: { input: renameInput, output: renameResult },
  associate: { input: z.object({ threadId: z.string().min(1).max(128), project: reference.nullable() }).strict(), output: z.null() },
  changeProject: { input: projectActionInput, output: z.object({
    state: z.enum(['done', 'assigned', 'partial', 'blocked', 'unconfirmed']),
    message: z.string(),
  }).strict() },
  newAreaThread: { input: newThreadInput, output: z.object({ threadId: z.string() }).strict() },
  newThread: { input: newThreadInput, output: z.object({ threadId: z.string() }).strict() },
});
