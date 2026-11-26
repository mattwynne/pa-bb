import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { areaFromNote, areaLookup, noteEvidence, projectFromNote, readVaultInventory, relativeFolder, vaultIdSchema, vaultRpc } from '../adapters/obsidian.ts';
import { noteSaveReceipt, reference } from '../contract.ts';
import { readThreadReferences } from './thread-references.ts';

export const renameAreaInput = reference.extend({
  source: vaultIdSchema,
  id: relativeFolder.refine(path => path.endsWith('.md')).describe('Exact Area note path ID from gtd_list_areas.'),
  newFilename: z.string().min(4).max(243).endsWith('.md')
    .refine(name => !/[\/\\<>:"|?*%#\[\]^\x00-\x1f\x7f]/u.test(name) && !name.startsWith('.') &&
      stem(name).trim() === stem(name) && !stem(name).endsWith('.') && Buffer.byteLength(name) <= 255)
    .describe('New Markdown filename including .md, in the same parent folder.'),
  requestId: z.string().uuid().optional().describe('Use a fresh UUID for a separately requested rename that reuses a previously completed path pair. Keep it on every retry.'),
}).strict();
type Input = z.infer<typeof renameAreaInput>;
type Scope = { vaultId: string; projectsFolder: string; areasFolder: string };
// Match the serialized recovery scope of requests admitted before path-only GTD.
const storedScope = ({vaultId, projectsFolder, areasFolder}: Scope) =>
  JSON.stringify({vaultId, projectsFolder, areasFolder, identity: 'legacy'});
type Move = { operationId: string; path: string; destination: string; attempted?: true; confirmed?: true };
type Assignment = { path: string; declaration: string | string[]; target: string; operationId?: string };
type Plan = { note: Move; hash: string; folder?: Move; descendants: string[]; assignments: Assignment[]; threads: string[]; threadAttempts: string[] };
type Inventory = Awaited<ReturnType<typeof readVaultInventory>>;
const moveReceipt = z.object({
  operationId: z.string().uuid(), vaultId: vaultIdSchema, path: relativeFolder, destination: relativeFolder,
  outcome: z.enum(['moved_locally_pending_sync', 'not_moved', 'uncertain']),
}).strict();
const declaration = z.union([z.string(), z.array(z.string()).min(1).max(8)]);
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + '/');
const pathKey = (path: string) => path.normalize('NFC').toLocaleLowerCase('und');
const stem = (path: string) => path.slice(0, -3);
function mapped(path: string, note: Move, folder?: Move) {
  if (path === note.path) return note.destination;
  if (folder && within(path, folder.path)) return folder.destination + path.slice(folder.path.length);
  return path;
}

class RenameIssue extends Error {
  constructor(readonly stage: string, message: string) { super(message); }
}
function requireEvidence(value: unknown, stage: string, message: string): asserts value {
  if (!value) throw new RenameIssue(stage, message);
}

export function areaRenames(bb: BbPluginApi, settings: () => Promise<Scope>) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS area_renames (
    vault TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, request_id TEXT NOT NULL, scope TEXT NOT NULL,
    plan TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vault,source,destination,request_id)
  )`);
  const active = new Set<string>();
  const threadWrites = new Set<string>();

  async function withKeys<T>(held: Set<string>, keys: string[], action: () => Promise<T>) {
    requireEvidence(keys.every(key => !held.has(key)), 'busy', 'A change to this Area or conversation is already running. Repeat the same request after it finishes.');
    for (const key of keys) held.add(key);
    try { return await action(); }
    finally { for (const key of keys) held.delete(key); }
  }
  const areaKey = (vault: string, path: string) => JSON.stringify([vault, pathKey(path)]);
  const withArea = <T>(ref: { source: string; id: string }, action: () => Promise<T>) =>
    withKeys(active, [areaKey(ref.source, ref.id)], action);
  const withThread = <T>(threadId: string, action: () => Promise<T>) => withKeys(threadWrites, [threadId], action);

  async function rename(input: Input, signal: AbortSignal) {
    const {source: vaultId, id, newFilename} = renameAreaInput.parse(input);
    const destination = posix.join(posix.dirname(id), newFilename);
    let plan: Plan | undefined;
    let stage = 'preflight';
    let pendingAssignment: {path: string; operationId: string} | undefined;
    const result = (state: string, action?: string) => ({
      state, source: vaultId, id, destination, noteOperationId: plan?.note.operationId ?? null,
      folderOperationId: plan?.folder?.operationId ?? null,
      noteMoveConfirmed: !!plan?.note.confirmed, folderMoveConfirmed: plan?.folder ? !!plan.folder.confirmed : null,
      ...(pendingAssignment ? { assignment: pendingAssignment } : {}),
      ...(action ? { stage, action } : {}),
    });
    try {
      return await withKeys(active, [...new Set([areaKey(vaultId, id), areaKey(vaultId, destination)])], async () => {
        const scope = await settings();
        const [selected, ...parts] = scope.vaultId.split('/');
        const root = parts.join('/');
        const areas = [root, scope.areasFolder].filter(Boolean).join('/');
        const projects = [root, scope.projectsFolder].filter(Boolean).join('/');
        const area = areaFromNote(areas, id);
        requireEvidence(selected === vaultId && area && area !== 'invalid' &&
          relativeFolder.safeParse(destination).success && pathKey(id) !== pathKey(destination) &&
          !within(projects, stem(id)) && !within(projects, stem(destination)) &&
          projectFromNote(projects, id) === 'invalid' && projectFromNote(projects, destination) === 'invalid', stage,
        'Choose an exact top-level Area note and a distinct filename in its configured Areas folder.');
        const scopeKey = storedScope(scope);
        const checkScope = async () => {
          signal.throwIfAborted();
          requireEvidence(storedScope(await settings()) === scopeKey, 'configuration', 'The GTD source or identity mode changed. Check settings before continuing.');
          signal.throwIfAborted();
        };
        const key = [vaultId, id, destination, input.requestId ?? ''] as const;
        const row = db.prepare('SELECT scope,plan,completed FROM area_renames WHERE vault=? AND source=? AND destination=? AND request_id=?')
          .get(...key) as { scope: string; plan: string; completed: number } | undefined;
        if (row) {
          plan = JSON.parse(row.plan) as Plan;
          requireEvidence(row.scope === scopeKey, 'configuration', 'Restore the original GTD source selection before inspecting this request.');
        }
        const inventory = async () => {
          const data = await readVaultInventory(bb.sdk, { vaultId, root, metadataFolders: [projects, areas], metadataDepth: 2, fields: ['area'] }, signal);
          const notes = new Set(data.notes.map(note => note.path));
          const folders = new Set(data.folders);
          requireEvidence(!data.incomplete && folders.has(areas) && folders.has(projects) && notes.size === data.notes.length,
            'inventory', 'Complete Area and project path evidence is required.');
          const projectNotes = new Map<string, unknown>();
          for (const note of data.notes) {
            if (!within(note.path, projects)) continue;
            const project = projectFromNote(projects, note.path);
            if (project) {
              requireEvidence(project !== 'invalid' && !note.malformed, 'inventory', 'A project note has an invalid path or unreadable frontmatter.');
              projectNotes.set(note.path, note.properties.area);
            }
          }
          return { data, notes, folders, projectNotes, resolve: areaLookup(root, areas, notes, folders) };
        };
        const refs = async () => {
          const scan = await readThreadReferences(bb.sdk, vaultId, signal);
          requireEvidence(scan.warnings.every(warning => warning === 'invalid_thread_reference'), 'threads', 'The active and archived thread scan is incomplete.');
          return scan.refs.filter(ref => ref.kind === 'area');
        };
        const observe = async (path: string, operationId?: string) =>
          noteEvidence.parse(await vaultRpc(bb.sdk, 'noteEvidence', { vaultId, path, ...(operationId ? { operationId } : {}) }, signal));
        const tree = (current: Awaited<ReturnType<typeof inventory>>, folder: string) =>
          [...current.notes, ...current.folders].filter(path => path.startsWith(folder + '/')).sort();
        const free = (current: Awaited<ReturnType<typeof inventory>>, ...paths: string[]) => {
          const occupied = new Set([...current.notes, ...current.folders].map(pathKey));
          return paths.every(path => !occupied.has(pathKey(path)));
        };
        const preflight = (current: Awaited<ReturnType<typeof inventory>>) => {
          requireEvidence(current.data.notes.some(note => note.path === id && !note.malformed), 'source', 'The exact Area note is unavailable.');
          requireEvidence(free(current, destination, stem(destination)), 'destination', 'The new Area filename or matching folder is occupied.');
          const note = { operationId: randomUUID(), path: id, destination };
          const folder = current.folders.has(stem(id))
            ? { operationId: randomUUID(), path: stem(id), destination: stem(destination) } : undefined;
          requireEvidence([...current.folders, ...current.notes].every(path =>
            pathKey(path) !== pathKey(stem(id)) || path === folder?.path), 'source', 'The matching support folder is ambiguous.');
          const after = (path: string) => mapped(path, note, folder);
          const projected = areaLookup(root, areas, new Set([...current.notes].map(after)), new Set([...current.folders].map(after)));
          const assignments: Assignment[] = [];
          for (const [path, raw] of current.projectNotes) {
            const before = current.resolve(raw, path);
            if (before && after(before) !== before) {
              assignments.push({ path, declaration: declaration.parse(raw), target: after(before) });
            } else {
              requireEvidence(projected(raw, path) === before, 'assignments', 'The new name would change another project’s Area resolution.');
            }
          }
          return { note, folder, assignments, descendants: folder ? tree(current, folder.path) : [] };
        };
        const receipt = async (move: Move, dispatch?: 'note' | 'folder') => {
          const raw = await (dispatch
            ? vaultRpc(bb.sdk, 'movePath', { vaultId, operationId: move.operationId, path: move.path, destination: move.destination,
              kind: dispatch, ...(dispatch === 'note' ? { expectedHash: plan!.hash } : {}) }, signal)
            : vaultRpc(bb.sdk, 'moveReceipt', { vaultId, operationId: move.operationId }, signal));
          const outcome = moveReceipt.nullable().parse(raw);
          requireEvidence(!outcome || (outcome.vaultId === vaultId && outcome.operationId === move.operationId &&
            outcome.path === move.path && outcome.destination === move.destination), stage, 'Obsidian returned mismatched move evidence.');
          return outcome?.outcome;
        };
        const save = () => db.prepare('UPDATE area_renames SET plan=? WHERE vault=? AND source=? AND destination=? AND request_id=?')
          .run(JSON.stringify(plan), ...key);
        if (row?.completed) {
          stage = 'completed_request';
          const current = await inventory();
          if (current.notes.has(id) || !current.notes.has(destination) ||
            await receipt(plan!.note) !== 'moved_locally_pending_sync' ||
            (plan!.folder && await receipt(plan!.folder) !== 'moved_locally_pending_sync')) {
            return result('historical', 'This request completed earlier. For a separately requested rename of the current Area, supply a fresh requestId.');
          }
          return { ...result('renamed'), assignmentsVerified: plan!.assignments.length, threadsVerified: plan!.threads.length };
        }
        if (!plan) {
          const pending = db.prepare('SELECT source,destination FROM area_renames WHERE vault=? AND completed=0').all(vaultId) as
            {source: string; destination: string}[];
          requireEvidence(!pending.some(entry => [entry.source, entry.destination].some(path => [id, destination].map(pathKey).includes(pathKey(path)))),
            'busy', 'An unfinished rename overlaps these paths. Repeat that original request to inspect it.');
          const prepared = preflight(await inventory());
          const { hash } = await observe(id);
          const direct = await refs();
          requireEvidence(!direct.some(ref => ref.id === destination), 'threads', 'Direct BB threads already point to the destination.');
          const candidate: Plan = { ...prepared, hash, threads: direct.filter(ref => ref.id === id).map(ref => ref.threadId), threadAttempts: [] };
          requireEvidence(Buffer.byteLength(JSON.stringify(candidate)) <= 512 * 1024, stage, 'The affected entries exceed the rename recovery limit.');
          await checkScope();
          db.prepare('INSERT INTO area_renames(vault,source,destination,request_id,scope,plan) VALUES (?,?,?,?,?,?)')
            .run(...key, scopeKey, JSON.stringify(candidate));
          plan = candidate;
        }
        const { note, folder, assignments, descendants } = plan;
        const capturedThreads = new Set(plan.threads);
        const confirmMoves = async () => {
          for (const move of folder ? [note, folder] : [note]) {
            requireEvidence(await receipt(move) === 'moved_locally_pending_sync', 'move_receipt', 'Inspect the original Obsidian move receipt and repeat this request when it can be confirmed.');
          }
        };
        const advance = async (move: Move, kind: 'note' | 'folder', check: () => Promise<void>) => {
          stage = kind + '_move';
          if (!move.attempted) {
            await check();
            await checkScope();
            move.attempted = true;
            save();
            return receipt(move, kind);
          }
          return receipt(move);
        };
        const forget = () => db.prepare('DELETE FROM area_renames WHERE vault=? AND source=? AND destination=? AND request_id=?').run(...key);
        const noteOutcome = await advance(note, 'note', async () => {
          const fresh = preflight(await inventory());
          requireEvidence(isDeepStrictEqual(fresh.assignments, assignments) && isDeepStrictEqual(fresh.descendants, descendants) &&
            fresh.folder?.path === folder?.path, 'preflight', 'Assignments or the supporting folder changed before the move.');
        }).catch(error => {
          if (!note.attempted) forget();
          throw error;
        });
        if (noteOutcome === 'not_moved' && !note.confirmed) {
          forget();
          bb.log.warn('GTD area_rename note_move refused');
          return result('refused', 'Obsidian confirmed the note stayed in place. Inspect the source and destination before making a fresh request.');
        }
        requireEvidence(noteOutcome === 'moved_locally_pending_sync', stage, 'Inspect the original Obsidian note receipt and repeat the same request.');
        note.confirmed = true;
        save();
        if (folder) {
          const folderOutcome = await advance(folder, 'folder', async () => {
            const current = await inventory();
            requireEvidence(current.folders.has(folder.path) && free(current, folder.destination) &&
              isDeepStrictEqual(tree(current, folder.path), descendants), 'folder_move', 'The supporting folder or its destination changed. Inspect both paths before continuing.');
            requireEvidence(await receipt(note) === 'moved_locally_pending_sync', 'move_receipt', 'The Area note move could no longer be confirmed.');
          });
          if (folderOutcome === 'not_moved' && !folder.confirmed) {
            const refused = result('partial', 'Obsidian refused the supporting folder move. Check both paths and repeat the same request.');
            folder.operationId = randomUUID();
            delete folder.attempted;
            save();
            bb.log.warn('GTD area_rename folder_move partial');
            return refused;
          }
          requireEvidence(folderOutcome === 'moved_locally_pending_sync', stage, 'Inspect the original Obsidian folder receipt and repeat the same request.');
          folder.confirmed = true;
          save();
        }
        stage = 'assignments';
        const current = await inventory();
        const targetExists = (target: string) => target.endsWith('/') ? current.folders.has(target.slice(0, -1)) : current.notes.has(target);
        const verifyPaths = (observed: Awaited<ReturnType<typeof inventory>>) => {
          requireEvidence(observed.notes.has(destination) && free(observed, id, stem(id)) &&
            (!folder || (observed.folders.has(folder.destination) && descendants.every(path =>
              observed.notes.has(mapped(path, note, folder)) || observed.folders.has(mapped(path, note, folder))))), stage,
          'The Area or a captured supporting path could not be verified.');
        };
        verifyPaths(current);
        for (const assignment of assignments) {
          const {path, target} = assignment;
          if (assignment.operationId) pendingAssignment = {path, operationId: assignment.operationId};
          requireEvidence(current.projectNotes.has(path) && targetExists(target), stage, 'A captured project or its Area target is unavailable.');
          const observed = await observe(path, assignment.operationId);
          if (current.resolve(observed.properties.area, path) === target) {
            pendingAssignment = undefined;
            continue;
          }
          requireEvidence(!assignment.operationId || observed.receipt === 'not_saved', stage,
            'Inspect the previous assignment save receipt and the project’s current Area declaration.');
          const old = assignment.declaration;
          const actual = declaration.safeParse(observed.properties.area).data;
          const before = Array.isArray(old) ? old : [old];
          const now = Array.isArray(actual) ? actual : [actual];
          requireEvidence(Array.isArray(old) === Array.isArray(actual) && before.length === now.length, stage, 'A project’s Area declaration changed independently.');
          const updated = now.map((entry, index) => {
            if (entry && current.resolve(entry, path) === target) return entry;
            requireEvidence(entry === before[index], stage, 'A project’s Area declaration changed independently.');
            const canonical = target.replace(/%/g, '%25').replace(/\|/g, '%7C');
            const wiki = entry.trim().match(/^\[\[[^|\]]+(\|.*)?\]\]$/u);
            return wiki ? `[[${canonical}${wiki[1] ?? ''}]]` : canonical;
          });
          const value = Array.isArray(old) ? updated : updated[0]!;
          // Resolve the replacement with the same rules used by the project list.
          requireEvidence(current.resolve(value, path) === target, stage, 'The replacement Area declaration could not be resolved.');
          await confirmMoves();
          await checkScope();
          assignment.operationId = randomUUID();
          pendingAssignment = {path, operationId: assignment.operationId};
          save();
          const saved = noteSaveReceipt.parse(await vaultRpc(bb.sdk, 'writeProperties', {
            vaultId, path, expectedHash: observed.hash, operationId: assignment.operationId, set: { area: value },
          }, signal));
          if (saved.operationId === assignment.operationId && saved.outcome === 'not_saved') {
            delete assignment.operationId;
            save();
            throw new RenameIssue(stage, 'Obsidian refused the assignment save. Check the project’s current Area declaration before repeating the same request.');
          }
          requireEvidence(saved.operationId === assignment.operationId && saved.outcome === 'saved_locally_pending_sync', stage,
            'Inspect the assignment save receipt and repeat the same request.');
          requireEvidence(current.resolve((await observe(path, assignment.operationId)).properties.area, path) === target, stage,
            'The saved assignment could not be verified.');
          pendingAssignment = undefined;
        }

        stage = 'threads';
        const direct = await refs();
        const before = direct.filter(ref => ref.id === id);
        requireEvidence(before.every(ref => capturedThreads.has(ref.threadId)) &&
          plan.threads.every(threadId => direct.some(ref => ref.threadId === threadId && [id, destination].includes(ref.id))), stage,
        'A direct Area thread changed independently. Review its association before repeating this request.');
        for (const {threadId} of before) await withThread(threadId, async () => {
          await confirmMoves();
          await checkScope();
          const previous = reference.safeParse((await bb.sdk.threads.getPluginMetadata({threadId, signal})).area).data;
          requireEvidence(previous?.source === vaultId && previous.id === id && !plan!.threadAttempts.includes(threadId), stage,
            'Inspect the previous thread update and its current Area reference before continuing.');
          plan!.threadAttempts.push(threadId);
          save();
          const changed = await bb.sdk.threads.updatePluginMetadata({threadId, set: { area: {source: vaultId, id: destination} }, signal});
          requireEvidence(isDeepStrictEqual(changed.area, {source: vaultId, id: destination}), stage, 'The BB thread update could not be verified.');
        });
        stage = 'verification';
        const final = await inventory();
        verifyPaths(final);
        const finalThreads = await refs();
        const previousPath = (path: string) => mapped(path, { ...note, path: note.destination, destination: note.path },
          folder && { ...folder, path: folder.destination, destination: folder.path });
        const oldLookup = areaLookup(root, areas, new Set([...final.notes].map(previousPath)), new Set([...final.folders].map(previousPath)));
        requireEvidence(assignments.every(({path, target}) => final.projectNotes.has(path) && final.resolve(final.projectNotes.get(path), path) === target) &&
          [...final.projectNotes].every(([path, raw]) => {
            const old = oldLookup(raw, path);
            return !old || mapped(old, note, folder) === old || final.resolve(raw, path) === mapped(old, note, folder);
          }) && !finalThreads.some(ref => ref.id === id) &&
          plan.threads.every(threadId => finalThreads.some(ref => ref.threadId === threadId && ref.id === destination)), stage,
        'Project assignments or direct BB thread references changed during verification.');
        await confirmMoves();
        await checkScope();
        db.prepare('UPDATE area_renames SET completed=1 WHERE vault=? AND source=? AND destination=? AND request_id=?').run(...key);
        return { ...result('renamed'), assignmentsVerified: assignments.length, threadsVerified: plan.threads.length };
      });
    } catch (error) {
      if (error instanceof RenameIssue) stage = error.stage;
      const state = plan?.note.confirmed ? 'partial' : plan?.note.attempted ? 'unconfirmed' : 'refused';
      bb.log.warn(`GTD area_rename ${stage} ${state}`);
      return result(state, error instanceof RenameIssue ? error.message :
        'Evidence is unavailable. Inspect any returned operation IDs and repeat the same request to check the recorded steps.');
    }
  }
  return { rename, withArea, withThread };
}
