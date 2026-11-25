import { posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { noteEvidence, ObsidianBackend, readVaultInventory, relativeFolder, vaultOptions, type PreviewEvidence } from '../adapters/obsidian.ts';
import { readThreadReferences } from './migration-preview.ts';
import { stableIds } from './identity.ts';
import { statuses } from './model.ts';
import { projectActionInput, reference } from '../contract.ts';
import { noteSaveReceipt } from '../contract.ts';
import { isDeepStrictEqual } from 'node:util';

export const changeNames = [
  'gtd_browse_area_targets',
  'gtd_prepare_project_change',
  'gtd_check_project_change',
  'gtd_defer_project',
  'gtd_change_project',
  'gtd_apply_project_change',
] as const;
const projectMove = z.enum(['standalone', 'paired']);
const moveOutcome = z.enum(['moved_locally_pending_sync', 'moved_supported_links_updated', 'moved_links_partial', 'project_move_partial', 'not_moved', 'uncertain']);
type MoveOutcome = z.infer<typeof moveOutcome>;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const deferInput = z.object({
  id: z.union([stableIds.project, relativeFolder.refine(id => id.endsWith('.md'), 'Use the exact project landing-note ID.')]),
  deferUntil: z.iso.date().refine(date => !date.startsWith('0000-'), 'Use a real calendar date in YYYY-MM-DD form.'),
}).strict();
const savedLocally = 'saved_locally_pending_sync';
function relativeAreaReference(value: unknown) {
  if (typeof value !== 'string') return false;
  try { return /^\.{1,2}\//.test(decodeURIComponent(value.trim().replace(/^\[\[/, ''))); }
  catch { return false; }
}
function localFieldHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify({ value })).digest('hex');
}
const planLifetime = 7 * 86400000;
function operationId(now = Date.now()) {
  const time = now.toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
}
export const browseInput = z
  .object({ folder: relativeFolder.optional(), offset: z.number().int().min(0).max(5000).optional() })
  .strict();
const changeParameters = z.object({
  source: z.string().min(1).max(128),
  id: relativeFolder,
  areaPath: relativeFolder.nullable().optional(),
  status: z.enum(statuses).optional(),
}).strict();
const oneChange = (x: z.infer<typeof changeParameters>) => (x.areaPath !== undefined) !== (x.status !== undefined);
export const prepareInput = changeParameters.extend({ expectedHash: hash }).refine(oneChange, 'Choose exactly one change.');
export const changeInput = changeParameters.refine(oneChange, 'Choose exactly one change.');
export const applyInput = z.object({ planId: z.string().uuid() }).strict();
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
  outcome: z.enum(['moved_locally_pending_sync', 'not_moved', 'uncertain']),
  legacy: z.object({
    paired: z.boolean(),
    expectedHash: hash.optional(),
    root: relativeFolder.optional(),
    outcome: moveOutcome,
  }).optional(),
});
const outcomeFor = (receipt: z.infer<typeof moveReceipt> | null): MoveOutcome | null =>
  receipt?.legacy?.outcome ?? receipt?.outcome ?? null;
type Config = { vaultId: string; projectsFolder: string; areasFolder: string };
type Reactivation = { stableId?: string; owner: string; destination: string; date: string; planId: string; cleanupId?: string };
type ReactivationFailure = 'inventory_unavailable' | 'candidate_blocked' | 'move_blocked' | 'move_unconfirmed' |
  'links_pending' | 'cleanup_unconfirmed';
const pacificCalendar = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
});
const reactivationRetryMs = 15 * 60_000;
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
  stableId?: string;
  settled?: true;
  threads: string[];
  direct?: true;
  noteAttempted?: boolean;
  folderOperation?: string;
  folderAttempted?: boolean;
  relativeAreaDeclaration?: unknown;
  areaOperation?: string;
  status?: string;
};
type Deferral = {
  stableId?: string;
  owner: string;
  destination: string;
  date: string;
  fieldHash: string;
  movePlan?: string;
  dateAttempt?: string;
  completed?: 'deferred' | 'move_repairs_pending';
};
export class LegacyMigrationBlocker extends Error {
  constructor(readonly stage: 'deferrals' | 'reactivations' | 'project_changes' | 'legacy_evidence') { super(stage); }
}
type StoredLegacyPlan = { id: string; plan: string; move_op: string | null; attempted: string };
const migrationDiagnosticLimit = 20;
const diagnosticOperationId = (value: unknown) => z.string().uuid().safeParse(value).data ?? null;
class ChangeError extends Error {}
const refuse = (message: string): never => {
  throw new ChangeError(message);
};
export function safeChangeError(e: unknown) {
  return e instanceof ChangeError
    ? e.message
    : 'Evidence unavailable or changed. Inspect the plan, note and receipts before any further write.';
}
export function projectChanges(bb: BbPluginApi, settings: () => Promise<Config & { automaticReactivation?: boolean; stableIdentity?: boolean }>, reactivationClock = Date.now) {
  const db = bb.storage.database();
  db.exec(
    `CREATE TABLE IF NOT EXISTS project_change_plans (id TEXT PRIMARY KEY, created INTEGER NOT NULL, plan TEXT NOT NULL, move_op TEXT, attempted TEXT NOT NULL DEFAULT '[]')`,
  );
  db.exec(`CREATE TABLE IF NOT EXISTS project_deferrals (
    scope TEXT NOT NULL, owner TEXT NOT NULL, destination TEXT NOT NULL, created INTEGER NOT NULL,
    move_plan TEXT, complete INTEGER NOT NULL, request TEXT NOT NULL, PRIMARY KEY (scope, owner)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS project_reactivation_runs (
    scope TEXT PRIMARY KEY, completed_day TEXT NOT NULL, attempt_day TEXT NOT NULL, retry_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_reactivations (
    scope TEXT NOT NULL, owner TEXT NOT NULL, plan_id TEXT NOT NULL UNIQUE,
    request TEXT NOT NULL, PRIMARY KEY (scope, owner)
  )`);
  const active = new Set<string>();
  const deferring = new Set<string>();
  async function scope() {
    const { vaultId, projectsFolder, areasFolder, stableIdentity } = await settings();
    if (vaultId === '__none__') return refuse('Choose a vault first.');
    const [source, ...rest] = vaultId.split('/');
    const root = rest.join('/');
    return {
      config: { vaultId, projectsFolder, areasFolder },
      source,
      root,
      stableIdentity,
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
  async function inventory(s: Awaited<ReturnType<typeof scope>>, signal: AbortSignal, stable = s.stableIdentity) {
    const e: PreviewEvidence = { owners: new Map(), entries: new Set() };
    const list = await new ObsidianBackend(
      bb.sdk,
      { vaultId: s.source, root: s.root, folder: s.config.projectsFolder, areasFolder: s.config.areasFolder },
      e, stable ? 'stable' : s.stableIdentity ? 'compatible' : 'legacy',
    ).readProjects(signal);
    if (!list.complete)
      refuse('Complete project and ownership evidence is required. No changes made.');
    return { e, rows: list.projects };
  }
  async function observeNote(vaultId: string, path: string, signal: AbortSignal, operationId?: string) {
    return noteEvidence.parse(await rpc('noteEvidence', { vaultId, path, operationId }, signal));
  }
  async function writeProperties(vaultId: string, path: string, expectedHash: string, change: {set?: Record<string, string>; remove?: string[]}, signal: AbortSignal, operationId?: string) {
    const result = noteSaveReceipt.parse(await rpc('writeProperties',
      { vaultId, path, expectedHash, operationId, ...change }, signal));
    if (operationId && result.operationId !== operationId) refuse('Unexpected property write receipt.');
    return result.outcome;
  }
  async function confirmArea(s: Awaited<ReturnType<typeof scope>>, path: string, signal: AbortSignal) {
    const result = await readVaultInventory(bb.sdk, { vaultId: s.source, root: s.root, folders: [posix.dirname(path)], fields: ['title'] }, signal);
    if (result.incomplete || result.notes.filter(note => note.path === path && !note.malformed).length !== 1)
      refuse('The exact Area note was not confirmed.');
  }
  async function browse(input: z.infer<typeof browseInput>, signal: AbortSignal) {
    const s = await scope();
    const folder = input.folder ?? s.areas;
    if (folder !== s.areas && !folder.startsWith(s.areas + '/'))
      refuse('Choose a folder inside the configured Areas folder.');
    if (s.root && !(await vaultOptions(bb.sdk, signal)).vaults.some((v) => v.selection === s.config.vaultId))
      refuse('Selected vault is unavailable.');
    const data = await readVaultInventory(bb.sdk, { vaultId: s.source, root: s.root, folders: [folder], fields: [] }, signal);
    const children = [
      ...data.notes.filter(note => posix.dirname(note.path) === folder).map(note => ({ path: note.path, kind: 'note' })),
      ...data.folders.filter(path => posix.dirname(path) === folder).map(path => ({ path, kind: 'folder' })),
    ].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const start = input.offset ?? 0;
    let bytes = 0;
    const entries = [];
    for (const entry of children.slice(start, start + 100)) {
      bytes += Buffer.byteLength(entry.path) + 80;
      if (bytes > 40000) break;
      entries.push(entry);
    }
    await unchanged(s.config);
    return {
      source: s.source,
      folder,
      entries,
      incomplete: data.incomplete || !data.folders.includes(folder),
      nextOffset: start + entries.length < children.length ? start + entries.length : null,
    };
  }
  async function prepare(input: z.infer<typeof prepareInput>, signal: AbortSignal,
    s?: Awaited<ReturnType<typeof scope>>, observed?: Awaited<ReturnType<typeof inventory>>, fromPanel = false) {
    s ??= await scope();
    if (input.source !== s.source) refuse('Wrong project source.');
    const { e, rows } = observed ?? await inventory(s, signal);
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
      direct: true,
      ...(item.notePath ? { stableId: item.id } : {}),
    };
    // Legacy note moves also require time-ordered operation IDs.
    const now = Date.now();
    const id = operationId(now);
    let next;
    if (input.areaPath !== undefined) {
      p.areaPath = input.areaPath;
      if (input.areaPath !== null) {
        if (p.stableId) await confirmStableArea(s, input.areaPath, signal);
        else {
          if (/[\[\]#|%]/.test(input.areaPath))
            refuse('This path contains link syntax and cannot be used as a literal Area declaration.');
          if (!input.areaPath.startsWith(s.areas + '/') || !input.areaPath.endsWith('.md'))
            refuse('Select an exact Markdown target under the configured Areas folder.');
          await confirmArea(s, input.areaPath, signal);
        }
      }
      const props = e.owners.get(owner)!;
      if (
        input.areaPath === null
          ? !Object.hasOwn(props, 'area')
          : props.area === input.areaPath && item.areaId === input.areaPath
      )
        return { state: 'already_complete', owner };
      next = { tool: 'gtd_apply_project_change' as const, input: { planId: id } };
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
      const declaration = e.owners.get(owner)?.area;
      if (item.areaId && (Array.isArray(declaration) ? declaration : [declaration]).some(relativeAreaReference))
        p.relativeAreaDeclaration = declaration;
      if (e.entries.has(destinationStem) || e.entries.has(destinationStem + '.md'))
        refuse('Destination note or support folder already exists.');
      if (!p.stableId) {
        const refs = await readThreadReferences(bb.sdk, s.source, signal, false);
        if (refs.warnings.length || refs.refs.some((r) => r.id === p.destination))
          refuse('Thread coverage is incomplete or destination already has references.');
        p.threads = refs.refs.filter((r) => r.id === item.id).map((r) => r.threadId);
      }
      if (!fromPanel && p.threads.length > 20) refuse('More than 20 linked conversations; manual review required.');
      if (p.project === 'paired') p.folderOperation = operationId(now);
      next = { tool: 'gtd_apply_project_change' as const, input: { planId: id } };
    }
    await unchanged(s.config);
    db.prepare(`DELETE FROM project_change_plans WHERE created < ? AND (
      json_extract(plan, '$.settled') = 1 OR (move_op IS NULL AND attempted = '[]'
      AND json_extract(plan, '$.direct') = 1 AND NOT coalesce(json_extract(plan, '$.noteAttempted'),0) AND NOT coalesce(json_extract(plan, '$.folderAttempted'),0))
    ) AND NOT EXISTS (
      SELECT 1 FROM project_deferrals WHERE move_plan = project_change_plans.id AND complete = 0
    ) AND NOT EXISTS (
      SELECT 1 FROM project_reactivations WHERE plan_id = project_change_plans.id
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
      destination: p.destination,
      next,
      notice:
        'This read prepares a change. Apply it once with the returned GTD operation.',
    };
  }
  function storedPlan(planId: string, recovering = false) {
    const row = db.prepare('SELECT plan,move_op,attempted,created FROM project_change_plans WHERE id=?')
      .get(planId) as { plan: string; move_op: string | null; attempted: string; created: number } | undefined;
    if (!row) return refuse('Plan not found. Inspect any original operation receipt.');
    const plan = JSON.parse(row.plan) as Plan;
    const pending = !plan.settled && (row.move_op || row.attempted !== '[]' || plan.noteAttempted || plan.folderAttempted || !plan.direct);
    if (!recovering && !pending && row.created < Date.now() - planLifetime)
      return refuse('Plan expired. Inspect the original operation receipt.');
    return { ...row, plan };
  }
  function recordPlan(planId: string, plan: Plan) {
    db.prepare('UPDATE project_change_plans SET plan=? WHERE id=?').run(JSON.stringify(plan), planId);
  }
  async function moveRecord(plan: Plan, operationId: string, path: string, destination: string,
    signal: AbortSignal, dispatch?: 'note' | 'folder') {
    const result = dispatch
      ? await rpc('movePath', { vaultId: plan.source, operationId, path, destination, kind: dispatch,
          ...(dispatch === 'note' ? { expectedHash: plan.expectedHash } : {}) }, signal)
      : await rpc('moveReceipt', { vaultId: plan.source, operationId }, signal);
    const receipt = moveReceipt.nullable().parse(result);
    if (receipt && (receipt.operationId !== operationId || receipt.vaultId !== plan.source ||
        receipt.path !== path || receipt.destination !== destination || (plan.direct && receipt.legacy)))
      refuse('The stored move receipt does not match this project change.');
    if (receipt && !plan.direct && plan.project && (receipt.legacy?.paired !== (plan.project === 'paired') ||
        receipt.legacy.expectedHash !== plan.expectedHash ||
        (receipt.legacy.root ?? '') !== plan.config.vaultId.split('/').slice(1).join('/')))
      refuse('The earlier move receipt does not match the recorded project change.');
    return receipt;
  }
  async function confirmStableArea(s: Awaited<ReturnType<typeof scope>>, id: string, signal: AbortSignal) {
    const snapshot = await new ObsidianBackend(bb.sdk, { vaultId: s.source, root: s.root, folder: s.config.projectsFolder,
      areasFolder: s.config.areasFolder }, undefined, 'stable').readAreas(signal);
    const area = snapshot.areas.find(area => area.id === id);
    if (!snapshot.complete || !area?.notePath) return refuse('The selected Area identity is unavailable.');
    const current = await observeNote(s.source, area.notePath, signal);
    if (current.properties.id !== id) refuse('The selected Area note changed.');
  }

  async function requireIdentity(plan: Plan, path: string, signal: AbortSignal, hash?: string) {
    if (!plan.stableId) return;
    const observed = await observeNote(plan.source, path, signal);
    if (observed.properties.id !== plan.stableId || (hash && hash !== observed.hash)) refuse('The project note identity or version changed.');
  }

  async function confirmMoveDestination(planId: string, signal: AbortSignal) {
    const { plan, move_op } = storedPlan(planId, true);
    const operation = plan.direct || plan.project ? planId : move_op;
    if (!plan.destination || !operation) return false;
    await requireIdentity(plan, plan.destination, signal);
    return (await moveRecord(plan, operation, plan.owner, plan.destination, signal))?.outcome === 'moved_locally_pending_sync';
  }
  async function advanceMove(planId: string, signal: AbortSignal, startNote: boolean, beforeWrite?: () => Promise<void>) {
    if (active.has(planId)) refuse('A project change is already in use.');
    active.add(planId);
    try {
      const { plan } = storedPlan(planId, true);
      if (!plan.direct || !plan.destination) return;
      await unchanged(plan.config);
      const { owner, destination } = plan;
      if ((await scope()).stableIdentity && !plan.stableId) return refuse('Inspect this legacy receipt without finishing links after identity cutover.');
      const verifyBeforeWrite = async () => {
        await unchanged(plan.config);
        await beforeWrite?.();
        signal.throwIfAborted();
      };
      let noteReceipt = await moveRecord(plan, planId, owner, destination, signal);
      if (!noteReceipt && startNote && !plan.noteAttempted) {
        await requireIdentity(plan, owner, signal, plan.expectedHash);
        await verifyBeforeWrite();
        plan.noteAttempted = true;
        recordPlan(planId, plan);
        noteReceipt = await moveRecord(plan, planId, owner, destination, signal, 'note');
      }
      if (noteReceipt?.outcome !== 'moved_locally_pending_sync') return;
      await requireIdentity(plan, destination, signal);
      if (plan.folderOperation) {
        const folderFrom = owner.slice(0, -3), folderTo = destination.slice(0, -3);
        let folderReceipt = await moveRecord(plan, plan.folderOperation, folderFrom, folderTo, signal);
        if (!folderReceipt && !plan.folderAttempted) {
          await verifyBeforeWrite();
          plan.folderAttempted = true;
          recordPlan(planId, plan);
          folderReceipt = await moveRecord(plan, plan.folderOperation, folderFrom, folderTo, signal, 'folder');
        }
        if (folderReceipt?.outcome !== 'moved_locally_pending_sync') return;
      }
      if (plan.relativeAreaDeclaration === undefined || !plan.originalArea || plan.areaOperation) return;
      const s = await scope();
      const { rows } = await inventory(s, signal);
      const item = rows.find(row => row.id === destination);
      if (!item || item.areaId === plan.originalArea) return;
      const current = await observeNote(plan.source, destination, signal);
      if (!isDeepStrictEqual(current.properties.area, plan.relativeAreaDeclaration)) return;
      if (plan.originalArea.endsWith('/')) {
        const folder = plan.originalArea.slice(0, -1);
        const result = await readVaultInventory(bb.sdk, { vaultId: plan.source, root: s.root, folders: [folder], fields: [] }, signal);
        if (result.incomplete || !result.folders.includes(folder)) return;
      } else {
        await confirmArea(s, plan.originalArea, signal);
      }
      await verifyBeforeWrite();
      if (!await confirmMoveDestination(planId, signal)) return;
      plan.areaOperation = operationId();
      recordPlan(planId, plan);
      await writeProperties(plan.source, destination, current.hash, { set: { area: plan.originalArea } }, signal, plan.areaOperation);
    } finally {
      active.delete(planId);
    }
  }
  async function check(input: z.infer<typeof checkInput>, signal: AbortSignal, recovering = false, beforeWrite?: () => Promise<void>) {
    if (input.finishLinks) {
      const { plan, move_op } = storedPlan(input.planId, recovering);
      if (input.receipt && (input.receipt.operationId !== (plan.direct || plan.project ? input.planId : move_op ?? input.receipt.operationId) || input.receipt.vaultId !== plan.source ||
          input.receipt.path !== plan.owner || input.receipt.destination !== plan.destination))
        refuse('The receipt does not match this project plan.');
      await advanceMove(input.planId, signal, false, beforeWrite);
    }
    if (active.has(input.planId)) refuse('Plan already in use.');
    active.add(input.planId);
    try {
      const { plan: p, ...row } = storedPlan(input.planId, recovering);
      await unchanged(p.config);
      const s = await scope();
      if (!p.destination) {
        const { e, rows } = await inventory(s, signal, !!p.stableId);
        const source = rows.find((r) => r.id === p.id);
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
      const operationId = p.direct || p.project ? input.planId : row.move_op ?? input.receipt?.operationId;
      if (input.receipt && (operationId !== input.receipt.operationId || input.receipt.vaultId !== s.source ||
        input.receipt.path !== p.owner || input.receipt.destination !== p.destination))
        return refuse('The receipt does not match this project plan.');
      const receipt = operationId ? await moveRecord(p, operationId, p.owner, p.destination, signal) : null;
      const folderReceipt = p.folderOperation ? await moveRecord(
        p, p.folderOperation, p.owner.slice(0, -3), p.destination.slice(0, -3), signal,
      ) : undefined;
      const moveOutcome = outcomeFor(receipt);
      if (receipt?.outcome !== 'moved_locally_pending_sync' ||
          (p.folderOperation && folderReceipt?.outcome !== 'moved_locally_pending_sync')) return {
        state: 'move_not_verified', operationId: operationId ?? null,
        folderOperationId: p.folderOperation ?? null,
        moveOutcome: receipt?.outcome === 'moved_locally_pending_sync' ? 'project_move_partial' as const : moveOutcome,
        action: 'Inspect the note and folder move receipts before repeating any write.',
      };
      const { e, rows } = await inventory(s, signal, !!p.stableId);
      const source = rows.find((r) => (r.notePath ?? r.id) === p.owner);
      const destinationId = p.destination;
      const destination = rows.find((r) => (r.notePath ?? r.id) === destinationId && (!p.stableId || r.id === p.stableId));
      const stem = p.destination.slice(0, -3);
      const sourceFolder = p.owner.slice(0, -3);
      if (
        (!p.stableId && (source || e.entries.has(p.owner) || e.entries.has(sourceFolder))) ||
        !destination ||
        destination.status !== p.status || destination.areaId !== p.originalArea ||
        e.entries.has(stem) !== (p.project === 'paired')
      ) return {
        state: 'move_not_verified',
        sourcePresent: !!source,
        destinationPresent: !!destination,
        operationId: operationId ?? null,
        moveOutcome: moveOutcome,
        action: 'Inspect the Obsidian move receipt and check the project inventory. For a partial or uncertain operation, do not replay.',
      };
      if (p.stableId) {
        if (input.finishLinks || recovering) {
          p.settled = true;
          recordPlan(input.planId, p);
        }
        return { state: 'links_verified', operationId: receipt.operationId, moveOutcome };
      }
      if (s.stableIdentity) return { state: 'legacy_receipt_verified', operationId: receipt.operationId, moveOutcome };
      const refs = await readThreadReferences(bb.sdk, s.source, signal, false);
      if (refs.warnings.length) refuse('Thread coverage incomplete.');
      await unchanged(s.config);
      const ids = new Set(p.threads);
      const before = refs.refs.filter((r) => r.id === p.id);
      const after = refs.refs.filter((r) => r.id === destinationId);
      if (before.length + after.length !== ids.size || [...before, ...after].some((r) => !ids.has(r.threadId)))
        refuse('Thread associations changed independently. Stop for reconciliation.');
      const completedState = moveOutcome === 'moved_supported_links_updated' || moveOutcome === 'moved_locally_pending_sync'
        ? 'links_verified' : 'move_repairs_pending';
      if (!input.finishLinks)
        return {
          state: before.length ? 'links_pending' : completedState,
          remaining: before.length,
          atDestination: after.length,
          moveOutcome: moveOutcome,
          operationId: receipt.operationId,
        };
      if (moveOutcome === 'uncertain') return refuse('Inspect the uncertain move before finishing conversations.');
      db.prepare('UPDATE project_change_plans SET move_op=? WHERE id=?').run(receipt.operationId, input.planId);
      const attempted = JSON.parse(row.attempted) as string[];
      for (const ref of before) {
        if (attempted.includes(ref.threadId))
          return {
            state: 'reconciliation_required',
            action: 'An earlier write was entered; inspect, do not retry.',
          };
        await unchanged(s.config);
        await beforeWrite?.();
        signal.throwIfAborted();
        const currentMove = await moveRecord(p, receipt.operationId, p.owner, destinationId, signal);
        if (currentMove?.outcome !== 'moved_locally_pending_sync')
          refuse('The note move is no longer confirmed. Inspect before updating conversations.');
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
      if (completedState === 'links_verified') {
        p.settled = true;
        recordPlan(input.planId, p);
      }
      return { state: completedState, atDestination: ids.size, moveOutcome: moveOutcome, operationId: receipt.operationId };
    } finally {
      active.delete(input.planId);
    }
  }
  async function apply(input: z.infer<typeof applyInput>, signal: AbortSignal) {
    const { plan } = storedPlan(input.planId);
    const s = await scope();
    await unchanged(plan.config);
    if (s.stableIdentity && !plan.stableId) return refuse('This legacy plan is available for receipt inspection.');
    if (!plan.direct) return check(input, signal);
    if (plan.destination) {
      await advanceMove(input.planId, signal, true).catch(() => bb.log.warn('GTD project_move reply_unconfirmed'));
      return check({ ...input, finishLinks: true }, signal);
    }

    if (active.has(input.planId)) refuse('A project change is already in use.');
    active.add(input.planId);
    try {
      const { e } = await inventory(s, signal);
      if (!e.owners.has(plan.owner)) refuse('A confirmed project landing note is required.');
      if (plan.areaPath) {
        if (plan.stableId) await confirmStableArea(s, plan.areaPath, signal);
        else await confirmArea(s, plan.areaPath, signal);
      }
      if (!plan.noteAttempted) {
        await requireIdentity(plan, plan.owner, signal, plan.expectedHash);
        await unchanged(plan.config);
        signal.throwIfAborted();
        plan.noteAttempted = true;
        recordPlan(input.planId, plan);
        try {
          await writeProperties(plan.source, plan.owner, plan.expectedHash,
            plan.areaPath ? { set: { area: plan.areaPath } } : { remove: ['area'] }, signal, input.planId);
        } catch {
          bb.log.warn('GTD area_assignment reply_unconfirmed');
        }
      }
    } finally { active.delete(input.planId); }
    return check(input, signal);
  }
  async function change(input: z.infer<typeof changeInput>, signal: AbortSignal) {
    const s = await scope();
    if (s.source !== input.source) refuse('Wrong project source.');
    const observed = await inventory(s, signal);
    const item = observed.rows.find(p => p.id === input.id);
    if (!item) return refuse('Exact project not found.');
    const note = await observeNote(s.source, item.notePath ?? item.id, signal);
    if (item.notePath && note.properties.id !== item.id) refuse('Project note identity changed.');
    const { hash: expectedHash } = note;
    const checked = await prepare({ ...input, expectedHash }, signal, s, observed);
    if (!checked.next || !checked.planId) return checked;
    try {
      return { planId: checked.planId, ...await apply({ planId: checked.planId }, signal) };
    } catch {
      bb.log.warn('GTD project_change write_unconfirmed');
      return { state: 'unconfirmed', planId: checked.planId, action: 'Inspect this GTD change before trying another write.' };
    }
  }
  const panelChanges = new Map<string, symbol>();
  async function archiveConversations(source: string, id: string, signal: AbortSignal) {
    const { refs, warnings } = await readThreadReferences(bb.sdk, source, signal, false);
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
    const result = await readThreadReferences(bb.sdk, source, signal, false);
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
      if (s.source !== input.source) refuse('Wrong project source.');
      const observed = await inventory(s, signal);
      const item = observed.rows.find(p => p.id === input.id);
      if (!item) return refuse('Exact project not found.');
      const note = await observeNote(s.source, item.notePath ?? item.id, signal);
      if (item.notePath && note.properties.id !== item.id) refuse('Project note identity changed.');
      const { hash: expectedHash } = note;
      const change = input.change;
      const plan = await prepare(prepareInput.parse({
        source: input.source, id: input.id, expectedHash,
        ...(change.kind === 'done' ? { status: 'done' } : { areaPath: change.areaPath }),
      }), signal, s, observed, true);
      await unchanged(s.config);
      if (!plan.next) {
        if (change.kind === 'area') return { state: 'assigned' as const, message: 'Project is already assigned to this Area.' };
        moved = true;
        await archiveConversations(s.source, input.id, signal);
        return { state: 'done' as const, message: 'All linked threads are archived.' };
      }

      const destination = plan.destination;
      if (destination) {
        const destinationKey = JSON.stringify([s.source, destination]);
        if (panelChanges.has(destinationKey)) refuse('A change for the destination project is already running.');
        panelChanges.set(destinationKey, lock);
        moveOperation = plan.planId;
      }
      writing = true;
      const result = await apply({ planId: plan.planId! }, signal);
      if (change.kind === 'area' && result.state === 'verified')
        return { state: 'assigned' as const, message: 'Project assigned locally. iCloud sync is pending.' };
      if (destination && result.state === 'links_verified') {
        moved = true;
        await archiveConversations(s.source, item.notePath ? item.id : destination, signal);
        return { state: 'done' as const, message: 'Project moved to Done locally and all linked threads archived.' };
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
      if (!s.stableIdentity) return await deferInScope(s, key, input, signal);
      const {rows} = await inventory(s, signal);
      const item = rows.find(row => row.id === input.id);
      if (!item?.notePath) return refuse('Exact project identity not found.');
      return await deferInScope(s, key, { ...input, id: item.notePath }, signal, item.id);
    } finally {
      deferring.delete(key);
    }
  }

  async function deferInScope(s: Awaited<ReturnType<typeof scope>>, key: string,
    { id, deferUntil }: z.infer<typeof deferInput>, signal: AbortSignal, stableId?: string) {
    const now = Date.now();
    db.prepare('DELETE FROM project_deferrals WHERE complete = 1 AND created < ?').run(now - planLifetime);
    const pending = db.prepare(`SELECT request FROM project_deferrals WHERE scope = ? AND complete = 0
      AND (owner = ? OR destination = ?) LIMIT 1`).get(key, id, id) as { request: string } | undefined;
    let request: Deferral;
    const dateEvidence = async (path: string, attempt?: string) => {
      const observed = await observeNote(s.source, path, signal, attempt);
      if (stableId && observed.properties.id !== stableId) refuse('Project note identity changed.');
      const value = observed.properties['defer-until'];
      return { ...observed, fieldHash: localFieldHash(value), matches: value === deferUntil };
    };
    const inDeferred = (path: string, e: PreviewEvidence) => {
      const folder = posix.dirname(path);
      return e.entries.has(folder) && posix.dirname(folder) === s.projects &&
        posix.basename(folder).toLowerCase() === 'deferred';
    };
    const confirmsDestination = () => !request.movePlan ? true : confirmMoveDestination(request.movePlan, signal);
    const saveRequest = (r: Deferral) => db.prepare(`INSERT INTO project_deferrals
      (scope, owner, destination, created, move_plan, complete, request) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(scope,owner) DO UPDATE SET destination=excluded.destination, created=excluded.created,
      move_plan=excluded.move_plan, complete=excluded.complete, request=excluded.request`).run(
      key, r.owner, r.destination, now, r.movePlan ?? null, r.completed ? 1 : 0, JSON.stringify(r));
    const forgetRequest = () => db.prepare('DELETE FROM project_deferrals WHERE scope = ? AND owner = ?').run(key, request.owner);
    if (pending) {
      request = JSON.parse(pending.request) as Deferral;
      if (request.stableId !== stableId) return refuse('A pending operation belongs to a different identity.');
      if (request.date !== deferUntil && id !== request.destination)
        return { state: 'deferral_pending', id: request.destination, deferUntil: request.date,
          moveOperationId: request.movePlan ?? null, dateOperationId: request.dateAttempt ?? null,
          action: 'Retry the original ID and date to reconcile the pending deferral. To change it, first confirm the current Deferred project ID.' };
    } else {
      const observed = await inventory(s, signal);
      const item = observed.rows.find(p => (p.notePath ?? p.id) === id && (!stableId || p.id === stableId));
      if (!item) {
        const old = db.prepare('SELECT request FROM project_deferrals WHERE scope = ? AND owner = ? AND complete = 1')
          .get(key, id) as { request: string } | undefined;
        if (!old) return refuse('Exact project ID not found in the configured source. List projects for its current ID.');
        request = JSON.parse(old.request) as Deferral;
        if (!observed.e.owners.has(request.destination) || !inDeferred(request.destination, observed.e))
          return refuse('The earlier destination is no longer in Deferred. List projects for its current ID.');
        if (request.date === deferUntil && (await dateEvidence(request.destination)).matches && await confirmsDestination()) {
          await unchanged(s.config);
          return { state: request.completed, id: request.destination, deferUntil, dateVerified: true, moveOperationId: request.movePlan };
        }
        return { state: 'project_id_changed', id: request.destination, action: 'Use the exact current ID to change the date.' };
      }
      if (!observed.e.owners.has(id)) refuse('A confirmed project landing note is required.');
      const baseline = await dateEvidence(id);
      request = { owner: id, destination: id, date: deferUntil, fieldHash: baseline.fieldHash, ...(stableId ? { stableId } : {}) };
      if ((db.prepare('SELECT COUNT(*) AS n FROM project_deferrals WHERE complete = 0').get() as { n: number }).n >= 256)
        refuse('Deferral recovery capacity reached. Inspect unresolved deferrals before starting another.');
      if (!inDeferred(id, observed.e)) {
        const plan = await prepare({ source: s.source, id: stableId ?? id, expectedHash: baseline.hash, status: 'deferred' }, signal, s, observed);
        if (!plan.destination || !plan.planId) return refuse('The Deferred destination is unavailable.');
        request.destination = plan.destination;
        request.movePlan = plan.planId;
        const overlapping = db.prepare(`SELECT 1 FROM project_deferrals WHERE scope = ? AND complete = 0
          AND (owner = ? OR destination = ?)`).get(key, request.destination, request.destination);
        if (overlapping) {
          db.prepare('DELETE FROM project_change_plans WHERE id = ?').run(plan.planId);
          refuse('An unresolved deferral holds this destination. Inspect the earlier move.');
        }
        saveRequest(request);
      }
    }

    let moveOutcome: MoveOutcome | null = null;
    const result = () => ({
      id: stableId ?? (moveOutcome === 'not_moved' ? request.owner : request.destination),
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
        try { await advanceMove(operation.planId, signal, true); }
        catch { bb.log.warn('GTD defer_move reply_unconfirmed'); }
        let checked = await check(operation, signal, true);
        if (checked.moveOutcome === 'project_move_partial') checked = await check({ ...operation, finishLinks: true }, signal, true);
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
      const observed = await dateEvidence(request.destination, request.dateAttempt);
      if (!await confirmsDestination())
        return partial('destination_unconfirmed', 'The moved note could not be confirmed at its destination. Inspect it before changing the date.');
      await unchanged(s.config);
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
        if (observed.fieldHash !== request.fieldHash || observed.receipt === savedLocally)
          return partial('date_changed', 'The defer-until field changed during this request. Review the current value in Obsidian. Use the current Deferred ID with a newly chosen date, or set the original requested date in Obsidian and repeat this request to verify it.');
        signal.throwIfAborted();
        request.dateAttempt = operationId();
        saveRequest(request);
        const saved = await writeProperties(s.source, request.destination, observed.hash,
          { set: { 'defer-until': deferUntil } }, signal, request.dateAttempt);
        if (saved === 'not_saved') {
          const failed = partial('date_not_saved', 'Obsidian declined the versioned date save. Review the current note, then retry this same deferral.');
          delete request.dateAttempt;
          saveRequest(request);
          return failed;
        }
        if (!(await dateEvidence(request.destination, request.dateAttempt)).matches || !await confirmsDestination())
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
  async function reactivate(signal: AbortSignal, startup: boolean) {
    const enabled = async () => !signal.aborted && (await settings()).automaticReactivation === true;
    if (!await enabled()) return;
    const s = await scope();
    const key = JSON.stringify([s.config.vaultId, s.config.projectsFolder]);
    const now = reactivationClock();
    const day = pacificCalendar.format(now);
    const previous = db.prepare('SELECT completed_day, attempt_day, retry_at FROM project_reactivation_runs WHERE scope = ?').get(key) as
      { completed_day: string; attempt_day: string; retry_at: number } | undefined;
    if (previous && (previous.completed_day >= day ||
        (!startup && previous.attempt_day === day && previous.retry_at > now))) return;

    const failures = new Map<ReactivationFailure, { count: number; operations: string[] }>();
    const fail = (failure: ReactivationFailure, planId?: string) => {
      const entry = failures.get(failure) ?? { count: 0, operations: [] };
      entry.count++;
      if (planId && entry.operations.length < 3) entry.operations.push(planId);
      failures.set(failure, entry);
    };
    const unfinished = db.prepare('SELECT request FROM project_reactivations WHERE scope = ? ORDER BY owner').all(key) as { request: string }[];
    const pending = new Set<string>();
    const save = (request: Reactivation) => db.prepare(`INSERT INTO project_reactivations (scope,owner,plan_id,request)
      VALUES (?,?,?,?) ON CONFLICT(scope,owner) DO UPDATE SET request=excluded.request`)
      .run(key, request.owner, request.planId, JSON.stringify(request));
    const finish = (request: Reactivation) =>
      db.prepare('DELETE FROM project_reactivations WHERE scope = ? AND owner = ?').run(key, request.owner);
    const evidence = async (path: string, attempt?: string) => {
      const observed = await observeNote(s.source, path, signal, attempt);
      return { ...observed, present: Object.hasOwn(observed.properties, 'defer-until'),
        date: deferInput.shape.deferUntil.safeParse(observed.properties['defer-until']).data ?? null };
    };
    const beforeWrite = async () => {
      await unchanged(s.config);
      if (!await enabled()) refuse('Automatic reactivation is paused.');
      signal.throwIfAborted();
    };
    const recover = async (request: Reactivation) => {
      const operation = { planId: request.planId };
      let stage: ReactivationFailure = 'move_unconfirmed';
      try {
        try { await advanceMove(operation.planId, signal, true, beforeWrite); }
        catch { /* Inspect the original receipts before any other write. */ }
        let checked = await check(operation, signal, true);
        if (checked.moveOutcome === 'project_move_partial') checked = await check({ ...operation, finishLinks: true }, signal, true, beforeWrite);
        if (checked.moveOutcome === 'not_moved') {
          finish(request);
          return fail('move_blocked', request.planId);
        }
        if (checked.state === 'move_not_verified') return fail(stage, request.planId);

        stage = 'links_pending';
        if (checked.state === 'links_pending' && checked.moveOutcome !== 'uncertain') {
          await check({ ...operation, finishLinks: true }, signal, true, beforeWrite);
          checked = await check(operation, signal, true);
        }
        if (checked.state !== 'links_verified') return fail(stage, request.planId);

        stage = 'cleanup_unconfirmed';
        const current = await evidence(request.destination, request.cleanupId);
        if (request.stableId && current.properties.id !== request.stableId) return fail(stage, request.planId);
        if (!await confirmMoveDestination(operation.planId, signal)) return fail(stage, request.planId);
        // A changed field belongs to the later edit. A confirmed receipt also
        // settles an earlier cleanup even if a date has since been added.
        if (!current.present || current.date !== request.date || current.receipt === savedLocally)
          return finish(request);
        if (request.cleanupId && current.receipt !== 'not_saved') return fail(stage, request.planId);

        await beforeWrite();
        request.cleanupId = operationId();
        save(request);
        const outcome = await writeProperties(s.source, request.destination, current.hash,
          { remove: ['defer-until'] }, signal, request.cleanupId);
        if (outcome === 'not_saved') {
          delete request.cleanupId;
          save(request);
          return fail(stage, request.planId);
        }
        const after = await evidence(request.destination, request.cleanupId);
        if ((after.present && after.date === request.date && after.receipt !== savedLocally) ||
            !await confirmMoveDestination(operation.planId, signal))
          return fail(stage, request.planId);
        finish(request);
      } catch {
        fail(stage, request.planId);
      }
    };

    for (const row of unfinished) {
      if (!await enabled()) return;
      const request = JSON.parse(row.request) as Reactivation;
      pending.add(request.owner);
      await recover(request);
    }
    try {
      const { rows, e } = await inventory(s, signal);
      for (const { id: identity, notePath, status } of rows) {
        const id = notePath ?? identity;
        const folder = posix.dirname(id);
        if (status !== 'deferred' || posix.dirname(folder) !== s.projects || posix.basename(folder).toLowerCase() !== 'deferred' ||
            !e.owners.has(id) || pending.has(id)) continue;
        if (!await enabled()) return;
        let request: Reactivation | undefined;
        try {
          const { hash, date } = await evidence(id);
          if (!date || date > day) continue;
          const deferral = db.prepare('SELECT 1 FROM project_deferrals WHERE scope = ? AND complete = 0 AND (owner = ? OR destination = ?)').get(key, id, id);
          if (deferral) { fail('candidate_blocked'); continue; }
          const plan = await prepare({ source: s.source, id: identity, expectedHash: hash, status: 'active' }, signal, s);
          if (!plan.destination || !plan.planId) { fail('candidate_blocked'); continue; }
          await beforeWrite();
          const verified = await evidence(id);
          if ((notePath && verified.properties.id !== identity) || verified.date !== date || verified.hash !== hash || date > pacificCalendar.format(reactivationClock())) continue;
          request = { owner: id, destination: plan.destination, date, planId: plan.planId, ...(notePath ? { stableId: identity } : {}) };
          save(request);
          await recover(request);
        } catch {
          fail(request ? 'move_unconfirmed' : 'candidate_blocked', request?.planId);
        }
      }
    } catch {
      fail('inventory_unavailable');
    }
    if (!await enabled()) return;
    db.prepare(`INSERT INTO project_reactivation_runs (scope,completed_day,attempt_day,retry_at) VALUES (?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET completed_day=excluded.completed_day,attempt_day=excluded.attempt_day,retry_at=excluded.retry_at`)
      .run(key, failures.size ? previous?.completed_day ?? '' : day, day, failures.size ? reactivationClock() + reactivationRetryMs : 0);
    for (const [stage, { count, operations }] of failures)
      bb.log.warn(`GTD reactivation ${stage} count=${count}${operations.length ? ` move_operations=${operations.join(',')}` : ''}`);
  }
  const legacyScope = (config: Config) => JSON.stringify([config.vaultId, config.projectsFolder]);
  function pendingChangePlans(config: Config) {
    const rows = db.prepare('SELECT id,plan,move_op,attempted FROM project_change_plans ORDER BY created, id').all() as StoredLegacyPlan[];
    return rows.flatMap(row => {
      const plan = JSON.parse(row.plan) as Plan;
      return isDeepStrictEqual(plan.config, config) && !plan.settled &&
        (row.move_op || row.attempted !== '[]' || plan.noteAttempted || plan.folderAttempted || !plan.direct) ? [{row,plan}] : [];
    });
  }
  async function inspectChangePlan(row: StoredLegacyPlan, signal: AbortSignal) {
    try {
      const result = await check({planId: row.id}, signal);
      return { ready: ['verified', 'links_verified'].includes(result.state) || result.moveOutcome === 'not_moved',
        state: result.state, moveOutcome: result.moveOutcome ?? null };
    } catch {
      signal.throwIfAborted();
      return { ready: false, state: 'evidence_unavailable', moveOutcome: null };
    }
  }
  async function migrationReadiness(config: Config, signal: AbortSignal) {
    const key = legacyScope(config);
    const deferralCount = (db.prepare('SELECT count(*) AS n FROM project_deferrals WHERE scope=? AND complete=0').get(key) as {n:number}).n;
    const reactivationCount = (db.prepare('SELECT count(*) AS n FROM project_reactivations WHERE scope=?').get(key) as {n:number}).n;
    const deferrals = (db.prepare('SELECT owner,move_plan,request FROM project_deferrals WHERE scope=? AND complete=0 ORDER BY owner LIMIT ?')
      .all(key, migrationDiagnosticLimit) as {owner:string; move_plan:string | null; request:string}[]).map(row => {
      const request = JSON.parse(row.request) as Deferral;
      return { projectId:relativeFolder.safeParse(row.owner).data ?? null, deferUntil:deferInput.shape.deferUntil.safeParse(request.date).data ?? null,
        movePlanId:diagnosticOperationId(row.move_plan), dateOperationId:diagnosticOperationId(request.dateAttempt) };
    });
    const reactivations = (db.prepare('SELECT plan_id,request FROM project_reactivations WHERE scope=? ORDER BY owner LIMIT ?')
      .all(key, migrationDiagnosticLimit) as {plan_id:string; request:string}[]).map(row => {
      const request = JSON.parse(row.request) as Reactivation;
      return { planId:diagnosticOperationId(row.plan_id), cleanupOperationId:diagnosticOperationId(request.cleanupId) };
    });
    const candidates = pendingChangePlans(config);
    const projectChanges = [];
    for (const {row,plan} of candidates.slice(0, migrationDiagnosticLimit)) {
      signal.throwIfAborted();
      const result = deferralCount || reactivationCount
        ? { ready:null, state:'not_checked', moveOutcome:null }
        : await inspectChangePlan(row, signal);
      projectChanges.push({ planId:diagnosticOperationId(row.id),
        moveOperationId:diagnosticOperationId(plan.destination && (plan.direct || plan.project ? row.id : row.move_op)),
        folderOperationId:diagnosticOperationId(plan.folderOperation),
        propertyOperationId:diagnosticOperationId(plan.areaOperation ?? (!plan.destination && plan.noteAttempted ? row.id : null)),
        ...result });
    }
    await unchanged(config);
    const firstBlocker = projectChanges.find(item => item.ready === false);
    const stage = deferralCount ? 'deferrals' : reactivationCount ? 'reactivations' :
      firstBlocker?.state === 'evidence_unavailable' ? 'legacy_evidence' :
      firstBlocker || candidates.length > projectChanges.length ? 'project_changes' : 'legacy_checks_passed';
    return { stage, counts:{deferrals:deferralCount, reactivations:reactivationCount, projectChanges:candidates.length},
      limitPerCategory:migrationDiagnosticLimit, deferrals, reactivations, projectChanges };
  }
  async function checkMigrationReady(config: Config, signal: AbortSignal) {
    await unchanged(config);
    const key = legacyScope(config);
    if (db.prepare('SELECT 1 FROM project_deferrals WHERE scope=? AND complete=0').get(key))
      throw new LegacyMigrationBlocker('deferrals');
    if (db.prepare('SELECT 1 FROM project_reactivations WHERE scope=?').get(key))
      throw new LegacyMigrationBlocker('reactivations');
    for (const {row,plan} of pendingChangePlans(config)) {
      const result = await inspectChangePlan(row, signal);
      if (!result.ready) throw new LegacyMigrationBlocker(result.state === 'evidence_unavailable' ? 'legacy_evidence' : 'project_changes');
      recordPlan(row.id, { ...plan, settled:true });
    }
  }
  return { browse, prepare, check, apply, change, defer, applyFromPanel, reactivate, checkMigrationReady, migrationReadiness };
}
