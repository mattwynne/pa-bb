import { z } from 'zod';

export const componentIds = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian', 'pa-updates'] as const;
export type ComponentId = typeof componentIds[number];
export const originUrl = 'https://github.com/mattwynne/pa-bb.git';
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceComponentSchema = z.object({
  local: z.boolean(), upstream: z.boolean(),
  working: fingerprint, origin: fingerprint, stamp: fingerprint.optional(),
});
export const workspaceSchema = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/), originHead: z.string().regex(/^[a-f0-9]{40}$/),
  dirty: z.boolean(), ahead: z.boolean(), behind: z.boolean(),
  components: z.record(z.enum(componentIds), workspaceComponentSchema),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceComponent = z.infer<typeof workspaceComponentSchema>;
export type SourceSync = { state: 'updated'; workspace: Workspace } | { state: 'held'; reason: 'local_work' | 'changed' | 'unavailable' };
export type CodeState = 'current' | 'local' | 'upstream' | 'both' | 'unapplied' | 'unknown';
/** One overall result: a Git-clean checkout alone never earns a green check. */
export function codeState(work: WorkspaceComponent | null, applied: string | null): CodeState {
  if (!work || !applied) return 'unknown';
  if (work.local && work.upstream) return 'both';
  if (work.local) return 'local';
  if (work.upstream) return 'upstream';
  return applied === work.working && work.working === work.origin ? 'current' : 'unapplied';
}
