import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { ObsidianBackend, relativeFolder, vaultOptions, type PreviewEvidence } from '../adapters/obsidian.ts';
import { readThreadReferences } from './migration-preview.ts';
import { statuses } from './model.ts';
import { isDeepStrictEqual } from 'node:util';

export const changeNames = [
  'gtd_browse_area_targets',
  'gtd_prepare_project_change',
  'gtd_check_project_change',
] as const;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const browseInput = z
  .object({ folder: relativeFolder.optional(), offset: z.number().int().min(0).max(5000).optional() })
  .strict();
export const prepareInput = z
  .object({
    source: z.string().min(1).max(128),
    id: z.string().min(1).max(1024),
    expectedHash: hash,
    areaPath: relativeFolder.nullable().optional(),
    status: z.enum(statuses).optional(),
  })
  .strict()
  .refine((x) => (x.areaPath !== undefined) !== (x.status !== undefined), 'Choose exactly one change.');
export const checkInput = z
  .object({
    planId: z.string().uuid(),
    receipt: z
      .object({
        operationId: z.string().uuid(),
        vaultId: z.string(),
        path: relativeFolder,
        destination: relativeFolder,
        physical: z.literal('moved_locally_pending_sync'),
        outcome: z.literal('moved_supported_links_updated'),
      })
      .optional(),
    finishLinks: z.boolean().optional(),
  })
  .strict();
type Config = { vaultId: string; projectsFolder: string; areasFolder: string };
type Plan = {
  config: Config;
  source: string;
  id: string;
  owner: string;
  expectedHash: string;
  areaPath?: string | null;
  destination?: string;
  originalArea?: string;
  threads: string[];
  status?: string;
};
const proof = z.object({
  revision: z.number().int(),
  epoch: z.string().uuid(),
  route: z.enum(['index', 'direct', 'legacy', 'legacy_conflict', 'legacy_pending']),
});
const childrenPage = z.object({
  entries: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(1024)
          .refine((s) => !s.includes('/') && relativeFolder.safeParse(s).success),
        kind: z.enum(['markdown', 'directory']),
      }),
    )
    .max(5000),
  incomplete: z.boolean(),
  authority: proof,
  publication: z.string().uuid().nullable(),
});
const targetPage = z.object({
  status: z.literal('matched'),
  matches: z.array(z.object({ path: relativeFolder, kind: z.enum(['directory', 'markdown']) })).max(3),
  fragment: z.literal(false),
  embed: z.literal(false),
  incomplete: z.literal(false),
  authority: proof,
  publication: z.string().uuid().nullable(),
});
class ChangeError extends Error {}
const refuse = (message: string): never => {
  throw new ChangeError(message);
};
export function safeChangeError(e: unknown) {
  return e instanceof ChangeError
    ? e.message
    : 'Evidence unavailable or changed. Inspect the plan, note and receipts before any further write.';
}
export function projectChanges(bb: BbPluginApi, settings: () => Promise<Config>) {
  const db = bb.storage.database();
  db.exec(
    `CREATE TABLE IF NOT EXISTS project_change_plans (id TEXT PRIMARY KEY, created INTEGER NOT NULL, plan TEXT NOT NULL, move_op TEXT, attempted TEXT NOT NULL DEFAULT '[]')`,
  );
  const active = new Set<string>();
  async function scope() {
    const { vaultId, projectsFolder, areasFolder } = await settings();
    if (vaultId === '__none__') return refuse('Choose a vault first.');
    const [source, ...rest] = vaultId.split('/');
    const root = rest.join('/');
    return {
      config: { vaultId, projectsFolder, areasFolder },
      source,
      root,
      areas: [root, areasFolder].filter(Boolean).join('/'),
      projects: [root, projectsFolder].filter(Boolean).join('/'),
    };
  }
  async function unchanged(config: Config) {
    if (JSON.stringify((await scope()).config) !== JSON.stringify(config))
      refuse('GTD settings changed. Stop and inspect the selected source.');
  }
  const rpc = (method: string, input: object, signal: AbortSignal) =>
    bb.sdk.plugins.callRpc<unknown>({
      pluginId: 'obsidian',
      method,
      input: JSON.parse(JSON.stringify(input)),
      signal,
      outputSchema: z.unknown(),
    });
  async function inventory(s: Awaited<ReturnType<typeof scope>>, signal: AbortSignal) {
    const e: PreviewEvidence = { owners: new Map(), entries: new Set() };
    const list = await new ObsidianBackend(
      bb.sdk,
      { vaultId: s.source, root: s.root, folder: s.config.projectsFolder, areasFolder: s.config.areasFolder },
      undefined,
      e,
    ).readProjects(signal);
    if (!list.complete || !e.proof)
      refuse('Complete project and ownership evidence is required. No changes made.');
    return { e, rows: list.projects };
  }
  async function revalidate(s: Awaited<ReturnType<typeof scope>>, e: PreviewEvidence, signal: AbortSignal) {
    await unchanged(s.config);
    const expected = e.proof;
    if (!expected) return refuse('Source authority unavailable.');
    const page = childrenPage.parse(await rpc('inventoryChildren', {vaultId:s.source,root:s.root,folder:s.projects,...expected},signal));
    if(page.incomplete || !isDeepStrictEqual(page.authority,expected.expectedAuthority) || (page.publication??undefined)!==expected.publication) refuse('Project inventory changed. Inspect before continuing.');
  }
  async function browse(input: z.infer<typeof browseInput>, signal: AbortSignal) {
    const s = await scope();
    const folder = input.folder ?? s.areas;
    if (folder !== s.areas && !folder.startsWith(s.areas + '/'))
      refuse('Choose a folder inside the configured Areas folder.');
    if (s.root && !(await vaultOptions(bb.sdk, signal)).vaults.some((v) => v.selection === s.config.vaultId))
      refuse('Selected vault is unavailable.');
    const page = childrenPage.parse(
      await rpc('inventoryChildren', { vaultId: s.source, root: s.root, folder }, signal),
    );
    const start = input.offset ?? 0;
    let bytes = 0;
    const entries = [];
    for (const e of page.entries.slice(start, start + 100)) {
      const path = folder + '/' + e.name;
      bytes += Buffer.byteLength(path) + 80;
      if (bytes > 40000) break;
      entries.push({ path, kind: e.kind === 'markdown' ? 'note' : 'folder' });
    }
    await unchanged(s.config);
    return {
      source: s.source,
      folder,
      entries,
      incomplete: page.incomplete,
      nextOffset: start + entries.length < page.entries.length ? start + entries.length : null,
    };
  }
  async function prepare(input: z.infer<typeof prepareInput>, signal: AbortSignal) {
    const s = await scope();
    if (input.source !== s.source) refuse('Wrong project source.');
    const { e, rows } = await inventory(s, signal);
    const item = rows.find((p) => p.id === input.id);
    if (!item) return refuse('Exact project not found. If already moved, inspect the original plan.');
    const owner = item.notePath ?? item.id;
    if (!owner.endsWith('.md') || !e.owners.has(owner)) refuse('A confirmed project landing note is required.');
    const p: Plan = {
      config: s.config,
      source: s.source,
      id: item.id,
      owner,
      expectedHash: input.expectedHash,
      threads: [],
    };
    let next;
    if (input.areaPath !== undefined) {
      p.areaPath = input.areaPath;
      if (input.areaPath !== null) {
        if (/[\[\]#|%]/.test(input.areaPath))
          refuse('This path contains link syntax and cannot be used as a literal Area declaration.');
        if (!input.areaPath.startsWith(s.areas + '/') || !input.areaPath.endsWith('.md'))
          refuse('Select an exact Markdown target under the configured Areas folder.');
        const target = targetPage.parse(
          await rpc(
            'inventoryTarget',
            { vaultId: s.source, root: s.root, path: owner, reference: input.areaPath, ...e.proof },
            signal,
          ),
        );
        if (
          !isDeepStrictEqual(target.authority, e.proof?.expectedAuthority) ||
          (target.publication ?? undefined) !== e.proof?.publication
        )
          refuse('Source authority changed; prepare again.');
        if (!target.matches.some((m) => m.kind === 'markdown' && m.path === input.areaPath))
          refuse('The exact Area note was not confirmed.');
      }
      const props = e.owners.get(owner)!;
      if (
        input.areaPath === null
          ? !Object.hasOwn(props, 'area')
          : props.area === input.areaPath && item.areaId === input.areaPath
      )
        return { state: 'already_complete', owner };
      next = {
        tool: 'obsidian_update_properties',
        input: {
          vaultId: s.source,
          path: owner,
          expectedHash: input.expectedHash,
          ...(input.areaPath === null ? { remove: ['area'] } : { set: { area: input.areaPath } }),
        },
      };
    } else {
      if (item.notePath || e.entries.has(owner.slice(0, -3)))
        refuse('Status moves support standalone project notes only; keep the support folder and stop.');
      const statusName = input.status![0].toUpperCase() + input.status!.slice(1);
      const dirs = [...e.entries].filter(
        (path) =>
          path.startsWith(s.projects + '/') &&
          !path.slice(s.projects.length + 1).includes('/') &&
          [statusName.toLowerCase(), ...(input.status === 'done' ? ['completed'] : [])].includes(
            path.slice(s.projects.length + 1).toLowerCase(),
          ),
      );
      if (dirs.length !== 1) refuse('The destination status folder must already exist unambiguously.');
      p.destination = dirs[0] + '/' + owner.split('/').at(-1);
      if (p.destination === owner && item.status === input.status) return { state: 'already_complete', owner };
      p.status = input.status;
      p.originalArea = item.areaId;
      if (e.entries.has(p.destination) || e.entries.has(p.destination.slice(0, -3)))
        refuse('Destination note or support folder already exists.');
      const refs = await readThreadReferences(bb.sdk, s.source, signal);
      if (refs.warnings.length || refs.refs.some((r) => r.id === p.destination))
        refuse('Thread coverage is incomplete or destination already has references.');
      p.threads = refs.refs.filter((r) => r.id === item.id).map((r) => r.threadId);
      if (p.threads.length > 20) refuse('More than 20 linked conversations; manual review required.');
      next = {
        tool: 'obsidian_move_note',
        input: {
          vaultId: s.source,
          path: owner,
          destination: p.destination,
          expectedHash: input.expectedHash,
          dryRun: true,
        },
      };
    }
    await revalidate(s,e,signal);
    const id = randomUUID();
    db.prepare('DELETE FROM project_change_plans WHERE created < ?').run(Date.now() - 7 * 86400000);
    if ((db.prepare('SELECT COUNT(*) AS n FROM project_change_plans').get() as { n: number }).n >= 256)
      refuse('Plan capacity reached.');
    db.prepare('INSERT INTO project_change_plans(id,created,plan) VALUES (?,?,?)').run(
      id,
      Date.now(),
      JSON.stringify(p),
    );
    return {
      state: 'prepared',
      planId: id,
      owner,
      previousArea: item.areaId ?? null,
      previousDeclaration: e.owners.get(owner)?.area ?? null,
      linkedThreads: p.threads.length,
      next,
      notice:
        'Preview only. Recheck the complete owner read/hash. For moves first require a ready Obsidian dry run; keep linked-thread changes exclusive. Never replay uncertain saves or moves.',
    };
  }
  async function check(input: z.infer<typeof checkInput>, signal: AbortSignal) {
    if (active.has(input.planId)) refuse('Plan already in use.');
    active.add(input.planId);
    try {
      const row = db
        .prepare('SELECT plan,move_op,attempted,created FROM project_change_plans WHERE id=?')
        .get(input.planId) as
        | { plan: string; move_op: string | null; attempted: string; created: number }
        | undefined;
      if (!row || row.created < Date.now() - 7 * 86400000)
        return refuse('Plan not found or expired. Do not repeat a prior write.');
      const p = JSON.parse(row.plan) as Plan;
      await unchanged(p.config);
      const s = await scope();
      const { e, rows } = await inventory(s, signal);
      const source = rows.find((r) => r.id === p.id);
      if (!p.destination) {
        if (input.finishLinks || input.receipt) refuse('This plan has no move.');
        const props = e.owners.get(p.owner);
        const ok =
          source &&
          (source.notePath ?? source.id) === p.owner &&
          props &&
          (p.areaPath === null
            ? !Object.hasOwn(props, 'area') && source.areaId === undefined
            : props.area === p.areaPath && source.areaId === p.areaPath);
        return {
          state: ok ? 'verified' : 'not_verified',
          owner: p.owner,
          requestedArea: p.areaPath,
          observedArea: source?.areaId ?? null,
        };
      }
      const destination = rows.find((r) => r.id === p.destination);
      if (
        source ||
        !destination ||
        destination.status !== p.status ||
        destination.areaId !== p.originalArea ||
        destination.notePath ||
        e.entries.has(p.destination.slice(0, -3))
      )
        return {
          state: 'move_not_verified',
          sourcePresent: !!source,
          destinationPresent: !!destination,
          action: 'Inspect Obsidian move receipt; do not replay.',
        };
      const refs = await readThreadReferences(bb.sdk, s.source, signal);
      if (refs.warnings.length) refuse('Thread coverage incomplete.');
      await revalidate(s,e,signal);
      const ids = new Set(p.threads);
      const before = refs.refs.filter((r) => r.id === p.id);
      const after = refs.refs.filter((r) => r.id === p.destination);
      if (before.length + after.length !== ids.size || [...before, ...after].some((r) => !ids.has(r.threadId)))
        refuse('Thread associations changed independently. Stop for reconciliation.');
      if (!input.finishLinks)
        return {
          state: before.length ? 'links_pending' : 'links_verified',
          remaining: before.length,
          atDestination: after.length,
        };
      const receipt = input.receipt;
      if (
        !receipt ||
        receipt.vaultId !== s.source ||
        receipt.path !== p.owner ||
        receipt.destination !== p.destination ||
        (row.move_op && row.move_op !== receipt.operationId)
      )
        return refuse('Inspect the exact successful Obsidian move receipt before finishing.');
      db.prepare('UPDATE project_change_plans SET move_op=? WHERE id=?').run(receipt.operationId, input.planId);
      const attempted = JSON.parse(row.attempted) as string[];
      for (const ref of before) {
        if (attempted.includes(ref.threadId))
          return {
            state: 'reconciliation_required',
            action: 'An earlier write was entered; inspect, do not retry.',
          };
        await revalidate(s,e,signal);
        signal.throwIfAborted();
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId: ref.threadId });
        const current = z.object({ source: z.literal(s.source), id: z.literal(p.id) }).safeParse(meta.project);
        if (!current.success) refuse('Thread reference changed; stop.');
        attempted.push(ref.threadId);
        db.prepare('UPDATE project_change_plans SET attempted=? WHERE id=?').run(
          JSON.stringify(attempted),
          input.planId,
        );
        await bb.sdk.threads.updatePluginMetadata({
          threadId: ref.threadId,
          set: { project: { source: s.source, id: p.destination } },
        });
        const updated = await bb.sdk.threads.getPluginMetadata({ threadId: ref.threadId });
        if (
          !z.object({ source: z.literal(s.source), id: z.literal(p.destination) }).safeParse(updated.project)
            .success
        )
          refuse('Thread write not verified. Inspect before continuing.');
      }
      return { state: 'links_verified', atDestination: ids.size };
    } finally {
      active.delete(input.planId);
    }
  }
  return { browse, prepare, check };
}
