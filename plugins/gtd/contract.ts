import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { listInput, pageSchema, areaListInput, areaPageSchema, snapshotSchema, areaSnapshotSchema } from './core/model.ts';
import { aliasSchema } from './core/identity.ts';
export const reference = z.object({
  source: z.string().min(1).max(1100),
  id: z.string().min(1).max(1024).describe('Exact inventory ID. New stable IDs use a hyphen after their kind prefix. Existing IDs and legacy paths are preserved verbatim.'),
}).strict();
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
export const noteSaveReceipt = z.object({ operationId: z.string().uuid(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']) }).strict();
export const standardTextLimit = 16000;
const standardText = z.string().max(standardTextLimit);
const noteHash = z.string().regex(/^[0-9a-f]{64}$/);
export const areaStandardInput = reference.extend({ text: standardText, expectedHash: noteHash, operationId: z.string().uuid() });
export const areaStandard = z.object({ text: standardText, hash: noteHash }).strict();
export const standardSaveResult = noteSaveReceipt.extend({ reason: z.enum(['changed', 'invalid_section']).optional() });
export const inventoryRevision = z.string().regex(/^[a-f0-9-]{36}:\d{1,16}$/).nullable();
export const rpcContract = defineRpcContract({
  inventoryRevision: { input: z.null(), output: inventoryRevision },
  browseInventory: {
    input: z.object({ includeAreas: z.boolean(), fresh: z.boolean().optional() }).strict(),
    output: z.object({ projects: snapshotSchema, areas: areaSnapshotSchema.nullable() }).strict(),
  },
  browseInventoryV2: {
    input: z.object({ includeAreas: z.boolean(), fresh: z.boolean().optional() }).strict(),
    output: z.object({ projects: snapshotSchema, areas: areaSnapshotSchema.nullable(),
      identity: z.enum(['legacy', 'applying', 'stable']), aliases: z.array(aliasSchema) }).strict(),
  },
  readAreaStandard: { input: reference, output: areaStandard },
  saveAreaStandard: { input: areaStandardInput, output: standardSaveResult },
  listProjects: { input: listInput, output: pageSchema },
  listAreas: { input: areaListInput, output: areaPageSchema },
  associate: { input: z.object({ threadId: z.string().min(1).max(128), project: reference.nullable() }).strict(), output: z.null() },
  changeProject: { input: projectActionInput, output: z.object({
    state: z.enum(['done', 'assigned', 'partial', 'blocked', 'unconfirmed']),
    message: z.string(),
  }).strict() },
  newAreaThread: { input: newThreadInput, output: z.object({ threadId: z.string() }).strict() },
  newThread: { input: newThreadInput, output: z.object({ threadId: z.string() }).strict() },
});
