import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { GtdError } from '../core/model.ts';
import type { Project, ProjectBackend, ProjectSnapshot, ProjectStatus, Warning } from '../core/model.ts';

export const relativeFolder = z.string().min(1).max(1024).refine(value =>
  !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'),
  'Use a relative folder such as Projects or Life/Projects, without a trailing slash.');
export const vaultIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
// Wire contracts are local to this adapter. No imports from another plugin's implementation.
const statusSchema = z.object({
  propertiesAccessVersion: z.number().int().optional(),
  vaults: z.array(z.object({ vaultId: vaultIdSchema, name: z.string().nullable(), source: z.object({
    local: z.object({ available: z.boolean() }), cloudConnected: z.boolean(), enabled: z.boolean(),
    phase: z.string().max(64), lastSuccess: z.string().nullable(), failure: z.string().max(128).nullable(),
  }).nullable() })),
});
const propertyPage = z.object({
  notes: z.array(z.object({ path: z.string().min(1).max(1024), properties: z.record(z.string(), z.unknown()) }).strict()).max(200),
  nextCursor: z.string().uuid().nullable(), incomplete: z.boolean(), warnings: z.array(z.string()).max(32), observedAt: z.string(),
}).strict();
const aliases: Record<string, ProjectStatus> = { active: 'active', deferred: 'deferred', someday: 'someday', done: 'done', completed: 'done' };
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export function projectFromNote(folder: string, path: string, properties: Record<string, unknown>): Project | 'invalid' | null {
  if (!path.startsWith(folder + '/') || !path.endsWith('.md') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return 'invalid';
  const parts = path.slice(folder.length + 1).split('/');
  const legacy = properties.type === undefined && (parts.length === 1 || (parts.length === 2 && ['Active', 'Someday', 'Done', 'Deferred'].includes(parts[0])));
  if (properties.type !== 'project' && !legacy) return null;
  const status = typeof properties.status === 'string' && Object.hasOwn(aliases, properties.status) ? aliases[properties.status] : undefined;
  if (!status) return properties.type === 'project' || properties.status !== undefined ? 'invalid' : null;
  const title = properties.title === undefined ? parts.at(-1)!.slice(0, -3) : properties.title;
  if (!text(title, 240)) return 'invalid';
  return { id: path, title: (title as string).trim(), status };
}

export class ObsidianBackend implements ProjectBackend {
  constructor(private sdk: BbPluginApi['sdk'], private config: { vaultId: string; folder: string }, private cleanupFailure: () => void = () => {}) {}
  private async status(signal: AbortSignal) {
    let state: z.infer<typeof statusSchema>;
    try { state = statusSchema.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'status', input: null, outputSchema: z.unknown(), signal })); }
    catch { throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable'); }
    if (state.propertiesAccessVersion !== 1) throw new GtdError('incompatible');
    return state;
  }
  async checkAccess(signal: AbortSignal) {
    const state = await this.status(signal);
    if (!state.vaults.find(vault => vault.vaultId === this.config.vaultId)?.source?.local.available) throw new GtdError('source_unavailable');
  }
  async readProjects(signal: AbortSignal): Promise<ProjectSnapshot> {
    const state = await this.status(signal);
    const vault = state.vaults.find(vault => vault.vaultId === this.config.vaultId);
    if (!vault?.source?.local.available) throw new GtdError('source_unavailable');
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const projects: Project[] = [], warnings = new Set<Warning>();
    let cursor: string | undefined, pages = 0, notes = 0, observedAt = new Date().toISOString();
    try {
      do {
        if (pages++ >= 128 || notes >= 5000 || readSignal.aborted) { warnings.add('scan_limit'); break; }
        let page: z.infer<typeof propertyPage>;
        try { page = propertyPage.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'listProperties', input: {
          vaultId: this.config.vaultId, folder: this.config.folder, fields: ['type', 'status', 'title'], ...(cursor ? { cursor } : {}),
        }, outputSchema: z.unknown(), signal: readSignal })); }
        catch (error) {
          if (signal.aborted) throw new GtdError('cancelled');
          if (readSignal.aborted) { warnings.add('scan_limit'); break; }
          throw new GtdError(error instanceof z.ZodError ? 'invalid_source' : 'source_unavailable');
        }
        cursor = page.nextCursor ?? undefined;
        observedAt = page.observedAt;
        if (page.incomplete || page.warnings.length) warnings.add('source_partial');
        for (const note of page.notes) {
          if (++notes > 5000) { warnings.add('scan_limit'); break; }
          const project = projectFromNote(this.config.folder, note.path, note.properties);
          if (project === 'invalid') warnings.add('invalid_project'); else if (project) projects.push(project);
        }
      } while (cursor);
    } finally {
      // Explicitly release the producer on cancellation/limits; do not leave invisible scans open.
      if (cursor) {
        try { await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'closeProperties', input: { cursor }, outputSchema: z.unknown(), signal: AbortSignal.timeout(3000) }); }
        catch { this.cleanupFailure(); /* Read-only handle expires upstream; no retry. */ }
      }
    }
    if (signal.aborted) throw new GtdError('cancelled');
    const source = vault.source;
    return { projects, complete: warnings.size === 0, warnings: [...warnings], source: {
      backend: 'obsidian', id: vault.vaultId, name: vault.name ?? 'Obsidian vault', scope: this.config.folder, observedAt,
      lastSuccessfulSync: source.lastSuccess,
      sync: { connected: source.cloudConnected, enabled: source.enabled, phase: source.phase, failure: source.failure },
    } };
  }
}
export async function connectedVaults(sdk: BbPluginApi['sdk'], signal: AbortSignal) {
  try {
    const state = statusSchema.parse(await sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'status', input: null, outputSchema: z.unknown(), signal }));
    return state.vaults.map(vault => ({ id: vault.vaultId, name: vault.name, available: vault.source?.local.available ?? false }));
  } catch { throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable'); }
}
