import { z } from 'zod';
import { runtimeReviewSchema, runtimeRowSchema, runtimeReceiptSchema, bbIntentSchema } from './runtime-model.ts';
import { componentIds, workspaceComponentSchema, workspaceSchema } from './workspace.ts';
export const integrationId = z.enum(componentIds);
const codeFacts = {
  workspace: workspaceComponentSchema.nullable().optional(),
  applied: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  sourceMode: z.enum(['managed', 'local', 'unsupported']).optional(),
};
export type IntegrationId = z.infer<typeof integrationId>;
export const failureCode = z.enum(['unavailable', 'baseline_unknown', 'changed', 'incompatible', 'paired_migration', 'maintenance_unavailable', 'interrupted', 'storage', 'busy', 'unsupported_install', 'not_installed', 'sync_recovery', 'source_work', 'local_pending']);
export type FailureCode = z.infer<typeof failureCode>;
export class ApplicationError extends Error {
  readonly category: FailureCode;
  constructor(category: FailureCode) { super(category); this.category = category; }
}
export const version = z.string().min(1).max(64);
export const developmentState = z.enum(['clean', 'unpublished', 'unknown']);
export const decisionSchema = z.enum(['automatic', 'choose', 'unverified']);
export const assessmentSchema = z.object({
  ...codeFacts,
  id: integrationId, installed: version, available: version,
  local: z.enum(['stock', 'custom', 'unknown']), fingerprint: z.string().max(128),
  prerequisite: failureCode.nullable(),
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  development: developmentState.optional(), decision: decisionSchema.optional(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export { localDecision, reviewDecision } from './decision.ts';
export const developmentWorkSchema = z.record(integrationId, developmentState);
export type DevelopmentWork = z.infer<typeof developmentWorkSchema>;
export const integrationInventorySchema = z.object({
  ...codeFacts,
  id: integrationId, installed: version, local: assessmentSchema.shape.local,
  state: z.enum(['current', 'offered', 'pinned', 'unavailable']), prerequisite: failureCode.nullable(),
  development: developmentState.optional(),
});
export type IntegrationInventoryRow = z.infer<typeof integrationInventorySchema>;
export const reviewSchema = z.object({ id: z.string().uuid(), at: z.string().datetime(), rows: z.array(assessmentSchema).max(6), runtime: runtimeReviewSchema.nullable().default(null), inventory: z.array(integrationInventorySchema).max(6).optional(),
  workspace: workspaceSchema.nullable().optional(), localRows: z.array(assessmentSchema).max(6).optional() });
const receiptSchema = z.object({ id: integrationId, choice: z.enum(['keep', 'install']), before: version,
  preview: version, actual: version.nullable(), outcome: z.enum(['pending', 'kept', 'skipped', 'activating', 'updated', 'unchanged', 'uncertain']) });
export const selfIntentSchema = z.object({ before: version, source: z.string().min(1).max(2048), requestedAt: z.string().datetime(),
  local: z.object({ path: z.string().min(1).max(4096), expected: z.string().regex(/^[a-f0-9]{64}$/), stamp: z.string().regex(/^[a-f0-9]{64}$/).optional(), instance: z.string().uuid() }).optional() });
export type SelfIntent = z.infer<typeof selfIntentSchema>;
export const sourceUpdateSchema = z.object({ before: z.string().regex(/^[a-f0-9]{40}$/), target: z.string().regex(/^[a-f0-9]{40}$/),
  actual: z.string().regex(/^[a-f0-9]{40}$/).nullable(), outcome: z.enum(['pending', 'activating', 'updated', 'held', 'uncertain']),
  reason: z.enum(['local_work', 'changed', 'unavailable']).nullable() });
const jobSchema = z.object({ id: z.string().uuid(), reviewId: z.string().uuid(),
  mode: z.enum(['origin', 'local']).optional(), sourceUpdate: sourceUpdateSchema.nullable().optional(),
  phase: z.enum(['preflight', 'quiescing', 'applying', 'restoring', 'restarting', 'self-updating', 'complete', 'attention']),
  receipts: z.array(receiptSchema).max(6), syncReserved: z.boolean(), failure: failureCode.nullable(),
  runtimeReceipts: z.array(runtimeReceiptSchema).max(3).default([]), bbIntent: bbIntentSchema.nullable().default(null),
  selfIntent: selfIntentSchema.nullable().default(null),
  confirmInterruptingThreads: z.boolean().default(false) });
export const applicationSavedSchema = z.object({ review: reviewSchema.nullable(), job: jobSchema.nullable() });
/** Read-only results from the current inspection, never persisted or apply authority. */
export const checkProgressSchema = z.object({
  id: z.string().uuid(), requested: z.boolean(),
  integrations: z.array(integrationInventorySchema).max(6), integrationsDone: z.boolean(),
  runtime: z.array(runtimeRowSchema).max(3), runtimeDone: z.boolean(), target: runtimeReviewSchema.shape.target,
});
export type CheckProgress = z.infer<typeof checkProgressSchema>;
export const applicationStatusSchema = applicationSavedSchema.extend({ checking: z.boolean(), applying: z.boolean(), failure: failureCode.nullable(),
  progress: checkProgressSchema.nullable().default(null),
  offers: z.object({ available: z.boolean(), checkedAt: z.string().datetime() }).nullable().default(null) });
export const applyInputSchema = z.object({ reviewId: z.string().uuid(), choices: z.array(z.object({ id: integrationId, choice: z.enum(['keep', 'install']) }).strict()).max(6), confirmInterruptingThreads: z.boolean().optional() }).strict();
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type ApplicationSaved = z.infer<typeof applicationSavedSchema>;
