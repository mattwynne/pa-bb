import { z } from 'zod';

export const statuses = ['active', 'deferred', 'someday', 'done'] as const;
export const statusSchema = z.enum(statuses);
export type ProjectStatus = z.infer<typeof statusSchema>;
export const projectSchema = z.object({
  // Backend-owned identity within the selected source, not a BB project ID.
  id: z.string().min(1).max(1024),
  title: z.string().min(1).max(240),
  status: statusSchema,
  areaId: z.string().min(1).max(1024).optional(),
}).strict();
export type Project = z.infer<typeof projectSchema>;
export const sourceSchema = z.object({
  backend: z.string().min(1).max(64), id: z.string().min(1).max(128),
  name: z.string().min(1).max(240), scope: z.string().min(1).max(1024),
  observedAt: z.string(), lastSuccessfulSync: z.string().nullable(),
  sync: z.object({ connected: z.boolean(), enabled: z.boolean(), phase: z.string().max(64), failure: z.string().max(128).nullable() }).strict().nullable(),
}).strict();
export const warnings = ['invalid_project', 'invalid_area', 'source_partial', 'scan_limit', 'duplicate_id'] as const;
export type Warning = typeof warnings[number];
export const snapshotSchema = z.object({
  source: sourceSchema, projects: z.array(projectSchema).max(5000),
  complete: z.boolean(), warnings: z.array(z.enum(warnings)).max(4),
}).strict();
export type ProjectSnapshot = z.infer<typeof snapshotSchema>;

/** Only this port is needed to add another backend. Core never sees vaults or YAML. */
export interface ProjectBackend {
  rename?(id: string, title: string, signal: AbortSignal): Promise<{ operationId: string; outcome: 'saved_locally_pending_sync' | 'not_saved' | 'uncertain' }>;
  readProjects(signal: AbortSignal): Promise<ProjectSnapshot>;
  checkAccess(signal: AbortSignal): Promise<void>;
}
export type BackendSelection = { key: string; backend: ProjectBackend };
export const errorCodes = ['unconfigured', 'source_unavailable', 'incompatible', 'invalid_configuration', 'invalid_source', 'cancelled', 'cursor_expired', 'capacity'] as const;
export type ErrorCode = typeof errorCodes[number];
const hints: Record<ErrorCode, string> = {
  unconfigured: 'Choose your vault by name and set the inventory folders in GTD settings. Reload GTD after connecting another Obsidian source.',
  source_unavailable: 'Check the selected source in Obsidian settings. Keep its configuration; no project data was changed.',
  incompatible: 'Update Obsidian to a version supporting the listProperties consumer RPC, then try again.',
  invalid_configuration: 'Choose an offered vault and use inventory folders relative to it, without parent-directory segments, in GTD settings.',
  invalid_source: 'The backend returned invalid inventory metadata. Check its integration and GTD plugin logs.',
  cancelled: 'The listing was cancelled. Start a new listing when ready.',
  cursor_expired: 'The listing expired or the source/settings/filter changed. Start a new listing without a cursor.',
  capacity: 'Too many listings are open. Finish a listing or wait five minutes before starting another.',
};
export class GtdError extends Error {
  readonly hint: string;
  constructor(readonly code: ErrorCode) { super(`GTD ${code.replaceAll('_', ' ')}.`); this.hint = hints[code]; }
}
export function safeError(error: unknown, signal?: AbortSignal): GtdError {
  return signal?.aborted ? new GtdError('cancelled') : error instanceof GtdError ? error : new GtdError('source_unavailable');
}
export const listInput = z.object({ status: z.enum(['all', ...statuses]).optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().uuid().optional() }).strict();
export type ListInput = z.infer<typeof listInput>;
export const countsSchema = z.object({ active: z.number().int().nonnegative(), deferred: z.number().int().nonnegative(), someday: z.number().int().nonnegative(), done: z.number().int().nonnegative() }).strict();
export const pageSchema = z.object({
  source: sourceSchema, projects: z.array(projectSchema).max(200),
  coverage: z.enum(['complete', 'partial']), warnings: z.array(z.enum(warnings)).max(4),
  totalProjects: z.number().int().nonnegative().nullable(),
  matchedProjects: z.number().int().nonnegative().nullable(), counts: countsSchema.nullable(),
  nextCursor: z.string().uuid().nullable(),
  consistency: z.literal('Per-project local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.'),
}).strict();
export type ProjectPage = z.infer<typeof pageSchema>;

export const areaSchema = projectSchema.omit({ status: true, areaId: true });
export type Area = z.infer<typeof areaSchema>;
export const areaSnapshotSchema = snapshotSchema.omit({ projects: true }).extend({ areas: z.array(areaSchema).max(5000) });
export type AreaSnapshot = z.infer<typeof areaSnapshotSchema>;
export interface AreaBackend {
  rename?(id: string, title: string, signal: AbortSignal): Promise<{ operationId: string; outcome: 'saved_locally_pending_sync' | 'not_saved' | 'uncertain' }>;
  readAreas(signal: AbortSignal): Promise<AreaSnapshot>;
  checkAccess(signal: AbortSignal): Promise<void>;
}
export type AreaBackendSelection = { key: string; backend: AreaBackend };
export const areaListInput = listInput.omit({ status: true });
export type AreaListInput = z.infer<typeof areaListInput>;
export const areaPageSchema = pageSchema.omit({ projects: true, totalProjects: true, matchedProjects: true, counts: true, consistency: true }).extend({
  areas: z.array(areaSchema).max(200), totalAreas: z.number().int().nonnegative().nullable(),
  consistency: z.literal('Per-area local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.'),
});
export type AreaPage = z.infer<typeof areaPageSchema>;
