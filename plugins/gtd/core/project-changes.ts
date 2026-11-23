import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { ObsidianBackend, relativeFolder, vaultOptions, type PreviewEvidence } from '../adapters/obsidian.ts';
import { readThreadReferences } from './migration-preview.ts';
import { statuses } from './model.ts';
import { projectActionInput, reference } from '../contract.ts';
import { isDeepStrictEqual } from 'node:util';

export const changeNames = [
  'gtd_browse_area_targets',
  'gtd_prepare_project_change',
  'gtd_check_project_change',
  'gtd_defer_project',
] as const;
const projectMove = z.enum(['standalone', 'paired']);
const physicalMove = z.enum(['moved_locally_pending_sync', 'not_moved', 'partial', 'uncertain']);
const moveOutcome = z.enum(['moved_supported_links_updated', 'moved_links_partial', 'project_move_partial', 'not_moved', 'uncertain']);
type MoveOutcome = z.infer<typeof moveOutcome>;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const deferInput = z.object({
  id: relativeFolder.refine(id => id.endsWith('.md'), 'Use the exact project landing-note ID.'),
  deferUntil: z.iso.date().refine(date => !date.startsWith('0000-'), 'Use a real calendar date in YYYY-MM-DD form.'),
}).strict();
const deferEvidence = z.object({
  hash, fieldHash: hash, matches: z.boolean(),
  receipt: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']).nullable(),
});
const deferSave = deferEvidence.shape.receipt.unwrap();
const deferMove = z.object({
  outcome: z.enum(['link_plan_ready', 'moved_supported_links_updated', 'moved_links_partial',
    'project_move_partial', 'not_moved', 'uncertain', 'blocked']),
  action: z.string().max(512).optional(),
});
const planLifetime = 7 * 86400000;
function operationId(now = Date.now()) {
  const time = now.toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
}
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
const moveReceipt = z.object({
  operationId: z.string().uuid(), vaultId: z.string(), path: relativeFolder, destination: relativeFolder,
  project: projectMove.optional(), root: relativeFolder.optional(), expectedHash: hash.optional(), physical: physicalMove, outcome: moveOutcome,
});
type Config = { vaultId: string; projectsFolder: string; areasFolder: string };
type Plan = {
  config: Config;
  source: string;
  id: string;
  owner: string;
  expectedHash: string;
  areaPath?: string | null;
  destination?: string;
  project?: z.infer<typeof projectMove>;
  originalArea?: string;
  threads: string[];
  status?: string;
};
type Deferral = {
  owner: string;
  destination: string;
  date: string;
  fieldHash: string;
  movePlan?: string;
  dateAttempt?: string;
  completed?: 'deferred' | 'move_repairs_pending';
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
  db.exec(`CREATE TABLE IF NOT EXISTS project_deferrals (
    scope TEXT NOT NULL, owner TEXT NOT NULL, destination TEXT NOT NULL, created INTEGER NOT NULL,
    move_plan TEXT, complete INTEGER NOT NULL, request TEXT NOT NULL, PRIMARY KEY (scope, owner)
  )`);
  const active = new Set<string>();
  const deferring = new Set<string>();
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
  async function prepare(input: z.infer<typeof prepareInput>, signal: AbortSignal,
    s?: Awaited<ReturnType<typeof scope>>, observed?: Awaited<ReturnType<typeof inventory>>, fromPanel = false) {
    s ??= await scope();
    if (input.source !== s.source) refuse('Wrong project source.');
    const { e, rows } = observed ?? await inventory(s, signal);
    const item = rows.find((p) => p.id === input.id);
    if (!item) return refuse('Exact project not found. If already moved, inspect the original plan.');
    const owner = item.id;
    if (!owner.endsWith('.md') || !e.owners.has(owner)) refuse('A confirmed project landing note is required.');
    const p: Plan = {
      config: s.config,
      source: s.source,
      id: item.id,
      owner,
      expectedHash: input.expectedHash,
      threads: [],
    };
    // Legacy note moves also require time-ordered operation IDs.
    const now = Date.now();
    const id = operationId(now);
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
        tool: 'obsidian_update_properties' as const,
        input: {
          vaultId: s.source,
          path: owner,
          expectedHash: input.expectedHash,
          ...(input.areaPath === null ? { remove: ['area'] } : { set: { area: input.areaPath } }),
        },
      };
    } else {
      const statusName = input.status![0].toUpperCase() + input.status!.slice(1);
      const dirs = [...e.entries].filter(
        (path) =>
          path.startsWith(s.projects + '/') &&
          !path.slice(s.projects.length + 1).includes('/') &&
          [statusName.toLowerCase(), ...(input.status === 'done' ? ['completed'] : [])].includes(
            path.slice(s.projects.length + 1).toLowerCase(),
          ),
      );
      if (dirs.length === 0) refuse(`Create a ${statusName} folder directly under the configured Projects folder in Obsidian, then retry.`);
      if (dirs.length > 1) refuse(`Resolve the duplicate ${statusName} folders under the configured Projects folder in Obsidian, then retry.`);
      p.project = e.entries.has(owner.slice(0, -3)) ? 'paired' : 'standalone';
      const destinationStem = dirs[0] + '/' + posix.basename(owner, '.md');
      p.destination = destinationStem + '.md';
      if (p.destination === owner && item.status === input.status) return { state: 'already_complete', owner };
      p.status = input.status;
      p.originalArea = item.areaId;
      if (e.entries.has(destinationStem) || e.entries.has(destinationStem + '.md'))
        refuse('Destination note or support folder already exists.');
      const refs = await readThreadReferences(bb.sdk, s.source, signal);
      if (refs.warnings.length || refs.refs.some((r) => r.id === p.destination))
        refuse('Thread coverage is incomplete or destination already has references.');
      p.threads = refs.refs.filter((r) => r.id === item.id).map((r) => r.threadId);
      if (!fromPanel && p.threads.length > 20) refuse('More than 20 linked conversations; manual review required.');
      next = {
        tool: 'obsidian_move_note' as const,
        input: {
          vaultId: s.source,
          path: owner,
          destination: p.destination,
          expectedHash: input.expectedHash,
          project: p.project,
          ...(s.root ? { root: s.root } : {}),
          operationId: id,
          dryRun: true,
        },
      };
    }
    await revalidate(s,e,signal);
    db.prepare(`DELETE FROM project_change_plans WHERE created < ? AND NOT EXISTS (
      SELECT 1 FROM project_deferrals WHERE move_plan = project_change_plans.id AND complete = 0
    )`).run(now - planLifetime);
    if ((db.prepare('SELECT COUNT(*) AS n FROM project_change_plans').get() as { n: number }).n >= 256)
      refuse('Plan capacity reached.');
    db.prepare('INSERT INTO project_change_plans(id,created,plan) VALUES (?,?,?)').run(
      id,
      now,
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
  async function check(input: z.infer<typeof checkInput>, signal: AbortSignal, recoveringDeferral = false) {
    if (active.has(input.planId)) refuse('Plan already in use.');
    active.add(input.planId);
    try {
      const row = db
        .prepare('SELECT plan,move_op,attempted,created FROM project_change_plans WHERE id=?')
        .get(input.planId) as
        | { plan: string; move_op: string | null; attempted: string; created: number }
        | undefined;
      if (!row || (!recoveringDeferral && row.created < Date.now() - planLifetime))
        return refuse('Plan not found or expired. Do not repeat a prior write.');
      const p = JSON.parse(row.plan) as Plan;
      await unchanged(p.config);
      const s = await scope();
      if (!p.destination) {
        const { e, rows } = await inventory(s, signal);
        const source = rows.find((r) => r.id === p.id);
        if (input.finishLinks || input.receipt) refuse('This plan has no move.');
        const props = e.owners.get(p.owner);
        const ok =
          source &&
          source.id === p.owner &&
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
      const operationId = p.project ? input.planId : row.move_op ?? input.receipt?.operationId;
      if (input.receipt && (operationId !== input.receipt.operationId || input.receipt.vaultId !== s.source ||
        input.receipt.path !== p.owner || input.receipt.destination !== p.destination))
        return refuse('The receipt does not match this project plan.');
      const receipt = operationId
        ? moveReceipt.nullable().parse(await rpc('projectMoveReceipt', { vaultId: s.source, operationId }, signal))
        : null;
      if (receipt && (operationId !== receipt.operationId || receipt.vaultId !== s.source ||
        receipt.path !== p.owner || receipt.destination !== p.destination || receipt.project !== p.project ||
        (p.project && (receipt.expectedHash !== p.expectedHash || (receipt.root ?? '') !== s.root)))) return refuse('The stored move receipt does not match this project plan.');
      if (receipt?.physical !== 'moved_locally_pending_sync') return {
        state: 'move_not_verified', operationId: operationId ?? null, moveOutcome: receipt?.outcome ?? null,
        action: 'Inspect the Obsidian move receipt. For a partial or uncertain operation, do not replay.',
      };
      const { e, rows } = await inventory(s, signal);
      const source = rows.find((r) => r.id === p.id);
      const destinationId = p.destination;
      const destination = rows.find((r) => r.id === destinationId);
      const stem = p.destination.slice(0, -3);
      const sourceFolder = p.owner.slice(0, -3);
      if (
        source || e.entries.has(p.owner) || e.entries.has(sourceFolder) ||
        !destination ||
        destination.status !== p.status || destination.areaId !== p.originalArea ||
        e.entries.has(stem) !== (p.project === 'paired')
      ) return {
        state: 'move_not_verified',
        sourcePresent: !!source,
        destinationPresent: !!destination,
        operationId: operationId ?? null,
        moveOutcome: receipt.outcome,
        action: 'Inspect the Obsidian move receipt and check the project inventory. For a partial or uncertain operation, do not replay.',
      };
      const refs = await readThreadReferences(bb.sdk, s.source, signal);
      if (refs.warnings.length) refuse('Thread coverage incomplete.');
      await revalidate(s,e,signal);
      const ids = new Set(p.threads);
      const before = refs.refs.filter((r) => r.id === p.id);
      const after = refs.refs.filter((r) => r.id === destinationId);
      if (before.length + after.length !== ids.size || [...before, ...after].some((r) => !ids.has(r.threadId)))
        refuse('Thread associations changed independently. Stop for reconciliation.');
      const completedState = receipt.outcome === 'moved_supported_links_updated' ? 'links_verified' : 'move_repairs_pending';
      if (!input.finishLinks)
        return {
          state: before.length ? 'links_pending' : completedState,
          remaining: before.length,
          atDestination: after.length,
          moveOutcome: receipt.outcome,
          operationId: receipt.operationId,
        };
      if (receipt.outcome === 'uncertain') return refuse('Inspect the uncertain Obsidian link repair before finishing conversations.');
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
          set: { project: { source: s.source, id: destinationId } },
        });
        const updated = await bb.sdk.threads.getPluginMetadata({ threadId: ref.threadId });
        if (
          !z.object({ source: z.literal(s.source), id: z.literal(destinationId) }).safeParse(updated.project)
            .success
        )
          refuse('Thread write not verified. Inspect before continuing.');
      }
      return { state: completedState, atDestination: ids.size, moveOutcome: receipt.outcome, operationId: receipt.operationId };
    } finally {
      active.delete(input.planId);
    }
  }
  const panelChanges = new Map<string, symbol>();
  async function archiveConversations(source: string, id: string, signal: AbortSignal) {
    const { refs, warnings } = await readThreadReferences(bb.sdk, source, signal);
    if (warnings.length) throw new Error('Incomplete thread listing.');
    for (const ref of refs) {
      if (ref.archived || ref.id !== id) continue;
      signal.throwIfAborted();
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ref.threadId });
      const linked = reference.safeParse(metadata.project).data;
      if (linked?.source !== source || linked.id !== id) continue;
      const result = await bb.sdk.threads.archive({ threadId: ref.threadId, signal });
      if (!result.archivedThreadIds.includes(ref.threadId) &&
          !(await bb.sdk.threads.get({ threadId: ref.threadId, signal })).archivedAt)
        throw new Error('Thread archive unconfirmed.');
    }
    const result = await readThreadReferences(bb.sdk, source, signal);
    if (result.warnings.length || result.refs.some(ref => ref.id === id && !ref.archived))
      throw new Error('Thread archive incomplete.');
  }

  async function applyFromPanel(input: z.infer<typeof projectActionInput>, signal: AbortSignal) {
    const key = JSON.stringify([input.source, input.id]);
    if (panelChanges.has(key)) return { state: 'blocked' as const, message: 'A change for this project is already running.' };
    const lock = Symbol();
    panelChanges.set(key, lock);
    let writing = false;
    let moved = false;
    let moveOperation: string | undefined;
    try {
      const s = await scope();
      if (s.source !== input.source || !input.id.startsWith(s.projects + '/') || !input.id.endsWith('.md'))
        refuse('A project note in the selected Projects folder is required.');
      const target = { vaultId: s.source, path: input.id };
      const expectedHash = hash.parse(await rpc('projectOwnerHash', target, signal));
      const change = input.change;
      const plan = await prepare(prepareInput.parse({
        source: input.source, id: input.id, expectedHash,
        ...(change.kind === 'done' ? { status: 'done' } : { areaPath: change.areaPath }),
      }), signal, s, undefined, true);
      await unchanged(s.config);
      if (!plan.next) {
        if (change.kind === 'area') return { state: 'assigned' as const, message: 'Project is already assigned to this Area.' };
        moved = true;
        await archiveConversations(s.source, input.id, signal);
        return { state: 'done' as const, message: 'All linked threads are archived.' };
      }

      const move = plan.next.tool === 'obsidian_move_note' ? plan.next.input : undefined;
      const destination = move?.destination;
      if (destination) {
        const destinationKey = JSON.stringify([s.source, destination]);
        if (panelChanges.has(destinationKey)) refuse('A change for the destination project is already running.');
        panelChanges.set(destinationKey, lock);
        moveOperation = plan.planId;
      }
      writing = true;
      if (change.kind === 'area') {
        const outcome = await rpc('applyProjectChange', { ...target, expectedHash, change }, signal);
        if (outcome === 'saved' && (await check({ planId: plan.planId! }, signal)).state === 'verified')
          return { state: 'assigned' as const, message: 'Project assigned locally. iCloud sync is pending.' };
      } else if (move && moveOperation) {
        const { destination, project, root } = move;
        const outcome = await rpc('applyProjectChange', {
          ...target, expectedHash, change: { kind: 'move', destination, project, root, operationId: moveOperation },
        }, signal);
        if (outcome === 'preview_blocked') return { state: 'blocked' as const, message: 'Obsidian could not prepare a safe move. Review the project and its links.' };
        const result = await check({ planId: moveOperation, finishLinks: true }, signal);
        if (result.state === 'links_verified' || result.state === 'move_repairs_pending') {
          moved = true;
          await archiveConversations(s.source, destination, signal);
          if (result.state === 'links_verified') return { state: 'done' as const, message: 'Project moved to Done locally and all linked threads archived.' };
          return { state: 'partial' as const, message: `Project moved and threads archived. Inspect Obsidian link repairs for operation ${moveOperation}.` };
        }
      }
      throw new Error('Project change unconfirmed.');
    } catch (error) {
      bb.log.warn(`GTD project_panel ${moved ? 'archive_incomplete' : writing ? 'write_unconfirmed' : 'prepare_blocked'}`);
      if (moved) return { state: 'partial' as const, message: 'Project is in Done. Some thread archives are unconfirmed. Open Done and choose Archive linked threads to check the remaining threads.' };
      if (writing) return { state: 'unconfirmed' as const, message: moveOperation
        ? `Project completion is unconfirmed. Inspect GTD plan and Obsidian move receipt ${moveOperation} before trying again.`
        : 'Area assignment is unconfirmed. Inspect the project note and Obsidian receipts before trying again.' };
      return { state: 'blocked' as const, message: error instanceof ChangeError ? error.message : 'Could not prepare the project change. Refresh GTD and check Obsidian access.' };
    } finally {
      for (const [id, owner] of panelChanges) if (owner === lock) panelChanges.delete(id);
    }
  }
  async function defer(input: z.infer<typeof deferInput>, signal: AbortSignal) {
    const s = await scope();
    const key = JSON.stringify([s.config.vaultId, s.config.projectsFolder]);
    if (deferring.has(key)) refuse('A deferral is in progress in this Projects folder. Wait for its result before retrying.');
    deferring.add(key);
    try {
      return await deferInScope(s, key, input, signal);
    } finally {
      deferring.delete(key);
    }
  }

  async function deferInScope(s: Awaited<ReturnType<typeof scope>>, key: string,
    { id, deferUntil }: z.infer<typeof deferInput>, signal: AbortSignal) {
    const now = Date.now();
    db.prepare('DELETE FROM project_deferrals WHERE complete = 1 AND created < ?').run(now - planLifetime);
    const pending = db.prepare(`SELECT request FROM project_deferrals WHERE scope = ? AND complete = 0
      AND (owner = ? OR destination = ?) LIMIT 1`).get(key, id, id) as { request: string } | undefined;
    let request: Deferral;
    const noteEvidence = async (path: string, attempt?: string) => deferEvidence.parse(await rpc('projectDeferEvidence',
      { vaultId: s.source, path, deferUntil, operationId: attempt }, signal));
    const inDeferred = (path: string, e: PreviewEvidence) => {
      const folder = posix.dirname(path);
      return e.entries.has(folder) && posix.dirname(folder) === s.projects &&
        posix.basename(folder).toLowerCase() === 'deferred';
    };
    const saveRequest = (r: Deferral) => db.prepare(`INSERT INTO project_deferrals
      (scope, owner, destination, created, move_plan, complete, request) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(scope,owner) DO UPDATE SET destination=excluded.destination, created=excluded.created,
      move_plan=excluded.move_plan, complete=excluded.complete, request=excluded.request`).run(
      key, r.owner, r.destination, now, r.movePlan ?? null, r.completed ? 1 : 0, JSON.stringify(r));
    const forgetRequest = () => db.prepare('DELETE FROM project_deferrals WHERE scope = ? AND owner = ?').run(key, request.owner);
    if (pending) {
      request = JSON.parse(pending.request) as Deferral;
      if (request.date !== deferUntil && id !== request.destination)
        return { state: 'deferral_pending', id: request.destination, deferUntil: request.date,
          moveOperationId: request.movePlan ?? null, dateOperationId: request.dateAttempt ?? null,
          action: 'Retry the original ID and date to reconcile the pending deferral. To change it, first confirm the current Deferred project ID.' };
    } else {
      const observed = await inventory(s, signal);
      const item = observed.rows.find(p => p.id === id);
      if (!item) {
        const old = db.prepare('SELECT request FROM project_deferrals WHERE scope = ? AND owner = ? AND complete = 1')
          .get(key, id) as { request: string } | undefined;
        if (!old) return refuse('Exact project ID not found in the configured source. List projects for its current ID.');
        request = JSON.parse(old.request) as Deferral;
        if (!observed.e.owners.has(request.destination) || !inDeferred(request.destination, observed.e))
          return refuse('The earlier destination is no longer in Deferred. List projects for its current ID.');
        if (request.date === deferUntil && (await noteEvidence(request.destination)).matches) {
          await revalidate(s, observed.e, signal);
          return { state: request.completed, id: request.destination, deferUntil, dateVerified: true, moveOperationId: request.movePlan };
        }
        return { state: 'project_id_changed', id: request.destination, action: 'Use the exact current ID to change the date.' };
      }
      if (!observed.e.owners.has(id)) refuse('A confirmed project landing note is required.');
      const baseline = await noteEvidence(id);
      request = { owner: id, destination: id, date: deferUntil, fieldHash: baseline.fieldHash };
      if ((db.prepare('SELECT COUNT(*) AS n FROM project_deferrals WHERE complete = 0').get() as { n: number }).n >= 256)
        refuse('Deferral recovery capacity reached. Inspect unresolved deferrals before starting another.');
      if (!inDeferred(id, observed.e)) {
        const plan = await prepare({ source: s.source, id, expectedHash: baseline.hash, status: 'deferred' }, signal, s, observed);
        if (!plan.next || plan.next.tool !== 'obsidian_move_note' || !plan.planId)
          return refuse('The checked Deferred move plan is unavailable.');
        request.destination = plan.next.input.destination;
        request.movePlan = plan.planId;
        const discardPlan = () => db.prepare('DELETE FROM project_change_plans WHERE id = ?').run(plan.planId);
        try {
          const overlapping = db.prepare(`SELECT 1 FROM project_deferrals WHERE scope = ? AND complete = 0
            AND (owner = ? OR destination = ?)`).get(key, request.destination, request.destination);
          if (overlapping) refuse('An unresolved deferral already holds this Deferred destination. Inspect the earlier move before continuing.');
          const preview = deferMove.parse(await rpc('projectDeferMove', plan.next.input, signal));
          if (preview.outcome !== 'link_plan_ready') refuse(preview.action ?? 'Obsidian could not verify the move preflight.');
          await revalidate(s, observed.e, signal);
          signal.throwIfAborted();
        } catch (error) {
          discardPlan();
          throw error;
        }
        saveRequest(request);
        let submitted;
        try {
          submitted = deferMove.parse(await rpc('projectDeferMove', { ...plan.next.input, dryRun: false }, signal));
        } catch {
          bb.log.warn('GTD defer_move reply_unconfirmed');
        }
        if (submitted?.outcome === 'blocked') {
          forgetRequest();
          discardPlan();
          refuse(submitted.action ?? 'Obsidian stopped before moving the project. Check the landing note and retry.');
        }
      }
    }

    let moveOutcome: MoveOutcome | null = null;
    const result = () => ({
      id: moveOutcome === 'not_moved' ? request.owner : request.destination,
      deferUntil, moveOperationId: request.movePlan ?? null, moveOutcome,
    });
    const partial = (state: 'not_moved' | 'move_unconfirmed' | 'destination_unconfirmed' | 'date_unconfirmed' | 'date_changed' | 'date_not_saved', action: string) => {
      bb.log.warn(`GTD project_defer ${state}`);
      return { ...result(), state, dateVerified: false, dateOperationId: request.dateAttempt ?? null, action };
    };
    let outcome: NonNullable<Deferral['completed']> = 'deferred';
    if (request.movePlan) {
      try {
        const operation = { planId: request.movePlan };
        let checked = await check(operation, signal, true);
        moveOutcome = checked.moveOutcome ?? null;
        if (checked.state === 'move_not_verified' && checked.moveOutcome === 'not_moved') {
          forgetRequest();
          return partial('not_moved', 'Obsidian confirmed that the project stayed in place. Inspect the move receipt before preparing a fresh deferral.');
        }
        if (checked.state === 'links_pending' && checked.moveOutcome !== 'uncertain')
          checked = await check({ ...operation, finishLinks: true }, signal, true);
        if (checked.state !== 'links_verified' && checked.state !== 'move_repairs_pending')
          return partial('move_unconfirmed', 'Inspect the Obsidian move receipt and captured conversation updates. Retry the same deferral after reconciling any partial or uncertain work.');
        outcome = checked.state === 'links_verified' ? 'deferred' : 'move_repairs_pending';
      } catch {
        return partial('move_unconfirmed', 'Inspect the Obsidian move receipt and captured conversation updates, then retry this same deferral to check their current state.');
      }
    }

    try {
      const { e } = await inventory(s, signal);
      if (!e.owners.has(request.destination) || !inDeferred(request.destination, e))
        return partial('destination_unconfirmed', 'Confirm the exact landing note in Deferred, then retry the same deferral.');
      const observed = await noteEvidence(request.destination, request.dateAttempt);
      await revalidate(s, e, signal);
      if (request.date !== deferUntil) {
        if (request.dateAttempt && (!observed.receipt || observed.receipt === 'uncertain'))
          return partial('date_unconfirmed', 'Inspect the earlier date save receipt before changing the date again.');
        request.date = deferUntil;
        request.fieldHash = observed.fieldHash;
        delete request.dateAttempt;
      }
      if (!observed.matches) {
        if (request.dateAttempt && (!observed.receipt || observed.receipt === 'uncertain'))
          return partial('date_unconfirmed', 'Inspect the date save receipt and the current defer-until field before updating it.');
        if (observed.fieldHash !== request.fieldHash || observed.receipt === 'saved_locally_pending_sync')
          return partial('date_changed', 'The defer-until field changed during this request. Review the current value in Obsidian. Use the current Deferred ID with a newly chosen date, or set the original requested date in Obsidian and repeat this request to verify it.');
        signal.throwIfAborted();
        request.dateAttempt = operationId();
        saveRequest(request);
        const saved = deferSave.parse(await rpc('projectDeferSave', {
          vaultId: s.source, path: request.destination, deferUntil, expectedHash: observed.hash,
          operationId: request.dateAttempt,
        }, signal));
        if (saved === 'not_saved') {
          const failed = partial('date_not_saved', 'Obsidian declined the versioned date save. Review the current note, then retry this same deferral.');
          delete request.dateAttempt;
          saveRequest(request);
          return failed;
        }
        if (!(await noteEvidence(request.destination, request.dateAttempt)).matches)
          return partial('date_unconfirmed', 'Inspect the date save receipt and the current defer-until field before updating it.');
        await unchanged(s.config);
      }
      request.completed = outcome;
      if (request.movePlan) saveRequest(request);
      else forgetRequest();
      if (outcome === 'move_repairs_pending') bb.log.warn('GTD project_defer move_repairs_pending');
      return { ...result(), state: outcome, dateVerified: true, dateOperationId: request.dateAttempt ?? null,
        ...(outcome === 'move_repairs_pending' ? { action: 'Inspect the Obsidian move receipt for unfinished note-link repairs.' } : {}) };
    } catch {
      return partial('date_unconfirmed', 'Retry this same deferral to check the Deferred note and any saved date receipt.');
    }
  }
  return { browse, prepare, check, defer, applyFromPanel };
}
