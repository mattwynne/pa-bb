import { z } from 'zod';

export const runtimeId = z.enum(['pi', 'codex', 'bb']);
export type RuntimeId = z.infer<typeof runtimeId>;
const version = z.string().min(1).max(64);
export const runtimeSource = z.enum(['npmGlobal', 'npm', 'source', 'external', 'missing', 'unknown']);
export const runtimeRowSchema = z.object({
  id: runtimeId, installed: version.nullable(), available: version.nullable(),
  source: runtimeSource, fingerprint: z.string().max(128),
  state: z.enum(['ready', 'current', 'unavailable']),
  reason: z.enum(['unsupported_install', 'not_installed', 'unavailable', 'busy', 'changed']).nullable(),
});
export const runtimeReviewSchema = z.object({
  target: z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(128) }).nullable(),
  runningThreadCount: z.number().int().nonnegative(), rows: z.array(runtimeRowSchema).max(3),
});
export const bbIntentSchema = z.object({
  previousResultId: z.string().nullable(), requestedAt: z.string().datetime(),
  fromVersion: version, fromCommit: z.string().nullable(), hostId: z.string().min(1),
});
export const runtimeReceiptSchema = z.object({
  id: runtimeId, before: version.nullable(), preview: version, actual: version.nullable(), source: runtimeSource,
  outcome: z.enum(['pending', 'activating', 'updated', 'unchanged', 'failed', 'uncertain']),
});
export type RuntimeReview = z.infer<typeof runtimeReviewSchema>;
export type RuntimeRow = z.infer<typeof runtimeRowSchema>;
export type BbIntent = z.infer<typeof bbIntentSchema>;
export type BbResult = { state: 'pending' | 'updated' | 'failed' | 'uncertain'; actual: string | null };
export type RuntimePorts = {
  inspect(onResult?: (row: RuntimeRow, target: RuntimeReview['target']) => void): Promise<RuntimeReview>;
  updateCli(id: 'pi' | 'codex', review: RuntimeReview): Promise<{ actual: string; source: 'npmGlobal' }>;
  prepareBb(review: RuntimeReview, confirmInterruptingThreads: boolean): Promise<BbIntent>;
  applyBb(intent: BbIntent, confirmInterruptingThreads: boolean): Promise<void>;
  reconcileBb(intent: BbIntent): Promise<BbResult>;
};
