import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { listInput, pageSchema, areaListInput, areaPageSchema } from './core/model.ts';
export const reference = z.object({ source: z.string().min(1).max(1100), id: z.string().min(1).max(1024) }).strict();
export const renameInput = reference.extend({ title: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/) });
export const renameResult = z.object({ operationId: z.string().uuid(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']) }).strict();
export const rpcContract = defineRpcContract({
  listProjects: { input: listInput, output: pageSchema },
  listAreas: { input: areaListInput, output: areaPageSchema },
  renameProject: { input: renameInput, output: renameResult },
  renameArea: { input: renameInput, output: renameResult },
  associate: { input: z.object({ threadId: z.string().min(1).max(128), project: reference.nullable() }).strict(), output: z.null() },
  newThread: { input: reference.extend({ requestId: z.string().uuid() }), output: z.object({ threadId: z.string() }).strict() },
});
