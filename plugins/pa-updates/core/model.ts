import { z } from 'zod';
import { releaseSchema } from './release.ts';
export const localSchema = z.object({
  outcome: z.enum(['local_changes', 'local_commits', 'clean', 'not_assessed', 'cannot_establish']),
  reason: z.enum(['observed', 'mapping_missing', 'no_candidate', 'unavailable', 'unsupported', 'target_missing', 'diverged', 'changed', 'limit', 'cancelled']),
  at: z.string().datetime(),
});
export type Local = z.infer<typeof localSchema>;
export const categorySchema = z.enum(['network', 'http', 'invalid', 'incomplete', 'mutated', 'unavailable', 'storage', 'cancelled']);
export type Category = z.infer<typeof categorySchema>;
export type Stage = 'feed' | 'inventory' | 'local' | 'storage';
export class CheckError extends Error {
  category: Category;
  constructor(category: Category) { super(category); this.category = category; }
}
export const installedSchema = z.object({ version: z.string().max(64), revision: z.string().regex(/^(?:[0-9a-f]{12}|[0-9a-f]{40})$/).nullable(), source: z.enum(['trusted', 'other', 'unavailable']) });
export const observationSchema = z.object({
  at: z.string().datetime(), release: releaseSchema.nullable(), installed: installedSchema.nullable().optional(),
  runtime: z.object({ bb: z.string().max(64), sdk: z.string().max(64) }).nullable(),
  local: localSchema, inventoryFailed: z.boolean(),
});
export const savedSchema = z.object({
  observation: observationSchema.nullable(), lastSuccess: z.string().datetime().nullable(), lastAttempt: z.string().datetime().nullable(),
  feedFailure: categorySchema.nullable(),
  pin: z.object({ identity: z.string().max(64), digest: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
});
export type Saved = z.infer<typeof savedSchema>;
export const statusSchema = savedSchema.omit({ pin: true }).extend({ checking: z.boolean(), stale: z.boolean(), storageFailure: z.boolean(), nextManualAt: z.string().datetime().nullable(), comparison: z.enum(['first', 'no_plugin', 'inventory_unavailable', 'no_release', 'current', 'available', 'installed_newer', 'source_mismatch', 'revision_unavailable', 'incompatible', 'compatibility_unavailable']) });
export type Status = z.infer<typeof statusSchema>;
export type Inventory = { installed: z.infer<typeof installedSchema> | null; runtime: { bb: string; sdk: string } | null };
export type Ports = {
  feed(signal: AbortSignal): Promise<{ text: string; identity: string } | null>;
  inventory(signal: AbortSignal): Promise<Inventory>;
  local(target: string | null, signal: AbortSignal): Promise<Local>;
  load(): Promise<unknown>; save(value: Saved): Promise<void>;
  now(): number; diagnose(stage: Stage, category: Category): void;
};
