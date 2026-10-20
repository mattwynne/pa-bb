import { z } from 'zod';
import { runtimeReviewSchema, runtimeReceiptSchema, bbIntentSchema } from './runtime-model.ts';
export const integrationId = z.enum(['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian']);
export type IntegrationId = z.infer<typeof integrationId>;
export const failureCode = z.enum(['unavailable', 'baseline_unknown', 'changed', 'incompatible', 'paired_migration', 'maintenance_unavailable', 'interrupted', 'storage', 'busy', 'unsupported_install', 'not_installed', 'sync_recovery']);
export type FailureCode = z.infer<typeof failureCode>;
export class ApplicationError extends Error {
  readonly category: FailureCode;
  constructor(category: FailureCode) { super(category); this.category = category; }
}
export const version = z.string().min(1).max(64);
export const assessmentSchema = z.object({
  id: integrationId, installed: version, available: version,
  local: z.enum(['stock', 'custom', 'unknown']), fingerprint: z.string().max(128),
  prerequisite: failureCode.nullable(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export const integrationInventorySchema = z.object({
  id: integrationId, installed: version, local: assessmentSchema.shape.local,
  state: z.enum(['current', 'offered', 'pinned', 'unavailable']), prerequisite: failureCode.nullable(),
});
export type IntegrationInventoryRow = z.infer<typeof integrationInventorySchema>;
export const reviewSchema = z.object({ id: z.string().uuid(), at: z.string().datetime(), rows: z.array(assessmentSchema).max(5), runtime: runtimeReviewSchema.nullable().default(null), inventory: z.array(integrationInventorySchema).max(5).optional() });
const receiptSchema = z.object({ id: integrationId, choice: z.enum(['keep', 'install']), before: version,
  preview: version, actual: version.nullable(), outcome: z.enum(['pending', 'kept', 'skipped', 'activating', 'updated', 'unchanged', 'uncertain']) });
const jobSchema = z.object({ id: z.string().uuid(), reviewId: z.string().uuid(),
  phase: z.enum(['preflight', 'quiescing', 'applying', 'restoring', 'restarting', 'complete', 'attention']),
  receipts: z.array(receiptSchema).max(5), syncReserved: z.boolean(), failure: failureCode.nullable(),
  runtimeReceipts: z.array(runtimeReceiptSchema).max(3).default([]), bbIntent: bbIntentSchema.nullable().default(null),
  confirmInterruptingThreads: z.boolean().default(false) });
export const applicationSavedSchema = z.object({ review: reviewSchema.nullable(), job: jobSchema.nullable() });
export const applicationStatusSchema = applicationSavedSchema.extend({ checking: z.boolean(), applying: z.boolean(), failure: failureCode.nullable(),
  offers: z.object({ available: z.boolean(), checkedAt: z.string().datetime() }).nullable().default(null) });
export const applyInputSchema = z.object({ reviewId: z.string().uuid(), choices: z.array(z.object({ id: integrationId, choice: z.enum(['keep', 'install']) }).strict()).max(5), confirmInterruptingThreads: z.boolean().optional() }).strict();
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type ApplicationSaved = z.infer<typeof applicationSavedSchema>;
