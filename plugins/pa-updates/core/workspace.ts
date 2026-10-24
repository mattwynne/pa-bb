import { z } from 'zod';

export const componentIds = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian', 'pa-updates'] as const;
export type ComponentId = typeof componentIds[number];
export const originUrl = 'https://github.com/mattwynne/pa-bb.git';
/** Only credential-free GitHub repository coordinates may leave the Git config boundary.
 * Reject credentials, URL extras, encoded paths and non-GitHub/local sources.
 * The SSH transport user `git` is not an account identity.
 */
export function normalizeGithubOrigin(value: string): string | undefined {
  if (value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,104})\/?$/i.exec(value);
  if (!match) return undefined;
  const owner = match[1].toLowerCase(), repo = match[2].replace(/\.git$/i, '').toLowerCase();
  if (!repo || repo === '.' || repo === '..' || repo.length > 100) return undefined;
  return `https://github.com/${owner}/${repo}.git`;
}
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceComponentSchema = z.object({
  local: z.boolean(), upstream: z.boolean(),
  working: fingerprint, origin: fingerprint, stamp: fingerprint.optional(),
});
export const workspaceSchema = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/), originHead: z.string().regex(/^[a-f0-9]{40}$/),
  dirty: z.boolean(), ahead: z.boolean(), behind: z.boolean(),
  configuredOrigin: z.string().refine(value => normalizeGithubOrigin(value) === value).optional(),
  // Optional for older snapshots/callers; only explicit true verifies ahead/behind
  // against the configured origin. Inspectors always emit a boolean.
  originComparisonMatches: z.boolean().optional(),
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
