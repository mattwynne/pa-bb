import { areaMailStatus, correspondenceLink, correspondenceStatus, linkLimit, projectCorrespondence, returnDate } from './core/correspondence.ts';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { listInput, pageSchema, areaListInput, areaPageSchema, snapshotSchema, areaSnapshotSchema, statusSchema } from './core/model.ts';
export const reference = z.object({
  source: z.string().min(1).max(1100),
  id: z.string().min(1).max(1024).describe('Exact path ID returned by the GTD inventory.'),
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
export const correspondenceReceipt = noteSaveReceipt.extend({ reason: z.enum(['changed', 'invalid_section']).optional() });
export const correspondenceChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snooze'), returnDate }).strict(),
  z.object({ kind: z.literal('unsnooze') }).strict(),
]);
export const correspondenceChangeResult = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['snoozed', 'unsnoozed', 'unchanged', 'not_saved', 'uncertain']), receipt: correspondenceReceipt.optional() }).strict(),
  z.object({ state: z.literal('blocked'), reason: z.enum(['not_listed', 'archived', 'unread', 'mail_unavailable', 'invalid_section', 'date_due']) }).strict(),
]);
export const correspondenceRefresh = z.object({
  correspondence: projectCorrespondence,
  mail: correspondenceStatus,
  returned: z.array(correspondenceLink.extend({ reason: z.enum(['date', 'unread']) })).max(linkLimit),
  snoozedMailIncomplete: z.boolean(),
  receipt: correspondenceReceipt.optional(),
}).strict();
export const projectName = z.string().trim().min(1).max(240).refine(value =>
  !value.startsWith('.') && !/[<>:"/\\|?*#\[\]\x00-\x1f\x7f]/.test(value) &&
  new TextEncoder().encode(value).length <= 252, 'Use a valid Obsidian filename.');
export const createProjectInput = reference.extend({ name: projectName, operationId: z.string().uuid() });
export const createProjectResult = z.discriminatedUnion('state', [
  z.object({ state: z.literal('created'), id: reference.shape.id }).strict(),
  z.object({ state: z.enum(['exists', 'blocked', 'uncertain']) }).strict(),
]);
export const standardTextLimit = 16000;
const standardText = z.string().max(standardTextLimit);
const noteHash = z.string().regex(/^[0-9a-f]{64}$/);
export const actionTextLimit = 2000;
export const actionText = z.string().trim().min(1).max(actionTextLimit).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const actionLine = z.number().int().min(1).max(standardTextLimit);
export const areaActionInput = reference.extend({
  operationId: z.uuid(),
  change: z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('add'), text: actionText }).strict(),
    z.object({ operation: z.literal('edit'), line: actionLine, version: noteHash, complete: z.boolean() }).strict(),
  ]),
});
const areaActionResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.enum(['saved_locally_pending_sync', 'unchanged', 'uncertain']) }).strict(),
  z.object({ outcome: z.literal('not_saved'), reason: z.enum(['changed', 'invalid_section', 'missing_action', 'unavailable']).optional() }).strict(),
]);
export const areaStandardInput = reference.extend({ text: standardText, expectedHash: noteHash, operationId: z.string().uuid() });
export const noteSection = z.object({ text: standardText, hash: noteHash }).strict();
export const nextAction = z.object({ text: standardText.nullable() }).strict();
export const standardSaveResult = noteSaveReceipt.extend({ reason: z.enum(['changed', 'invalid_section']).optional() });
export const inventoryRevision = z.string().regex(/^[a-f0-9-]{36}:\d{1,16}$/).nullable();
export const rpcContract = defineRpcContract({
  inventoryRevision: { input: z.null(), output: inventoryRevision },
  browseInventory: {
    input: z.object({ includeAreas: z.boolean(), fresh: z.boolean().optional() }).strict(),
    output: z.object({ projects: snapshotSchema, areas: areaSnapshotSchema.nullable() }).strict(),
  },
  readAreaMailStatus: { input: z.object({
    source: reference.shape.source, areaId: reference.shape.id.nullable(),
    status: z.union([z.literal('all'), statusSchema]),
  }).strict(), output: areaMailStatus },
  readCorrespondence: { input: reference, output: projectCorrespondence },
  readCorrespondenceStatus: { input: reference, output: correspondenceStatus },
  refreshCorrespondence: { input: reference, output: correspondenceRefresh },
  changeCorrespondenceSnooze: {
    input: reference.extend({ url: correspondenceLink.shape.url, operationId: z.uuid(), change: correspondenceChange }),
    output: correspondenceChangeResult,
  },
  readNextAction: { input: reference, output: nextAction },
  readAreaActions: { input: reference, output: z.object({
    version: noteHash,
    actions: z.array(z.object({ line: actionLine, text: standardText, complete: z.boolean() }).strict()),
  }).strict() },
  changeAreaAction: { input: areaActionInput, output: areaActionResult },
  readAreaStandard: { input: reference, output: noteSection },
  saveAreaStandard: { input: areaStandardInput, output: standardSaveResult },
  listProjects: { input: listInput, output: pageSchema },
  listAreas: { input: areaListInput, output: areaPageSchema },
  createProject: { input: createProjectInput, output: createProjectResult },
  associate: { input: z.object({ threadId: z.string().min(1).max(128), project: reference.nullable() }).strict(), output: z.null() },
  changeProject: { input: projectActionInput, output: z.object({
    state: z.enum(['done', 'assigned', 'partial', 'blocked', 'unconfirmed']),
    message: z.string(),
  }).strict() },
  newAreaThread: { input: newThreadInput, output: z.object({ threadId: z.string() }).strict() },
  newThread: { input: newThreadInput, output: z.object({ threadId: z.string() }).strict() },
});
