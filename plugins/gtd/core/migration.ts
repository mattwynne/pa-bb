import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { noteEvidence, ObsidianBackend, vaultRpc } from '../adapters/obsidian.ts';
import { noteSaveReceipt, reference } from '../contract.ts';
import { migrationPreview, migrationPreviewVersion, readThreadReferences, type Preview, type RenameEvidence } from './migration-preview.ts';
import { threadChoiceKey, type MigrationChoices } from './migration-choices.ts';
import { scopeKey, type Alias, type IdentityScope } from './identity.ts';

type NoteStep = { operationId: string; savedHash?: string };
type NoteSteps = { id?: NoteStep; area?: NoteStep };
type Manifest = {
  preview: Omit<Preview, 'version'> & { version: number };
  renames: RenameEvidence;
  notes: Record<string, NoteSteps>;
  threads: Record<string, 'entered' | 'verified'>;
};
type Run = { id: string; state: 'review' | 'applying' | 'stable'; manifest: string };

const blocked = (message: string): never => { throw new Error(message); };
export class OutdatedMigrationReview extends Error {}
const validLink = (link: Preview['links'][number]) => !!link.proposedId &&
  (!link.decision || link.decision === 'verified_rename' || link.decision === 'explicit_reassignment');
export const decisions = (preview: Pick<Preview, 'rows' | 'links' | 'renameMappings'>) =>
  preview.rows.filter(row => row.decisions.length).length +
  preview.links.filter(link => !validLink(link)).length +
  preview.renameMappings.filter(rename => rename.decision !== 'verified_rename').length;

export function identityMigration(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS identity_runs (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS identity_active_scope ON identity_runs(scope) WHERE state != 'review';`);
  const active = (config: IdentityScope) => db.prepare(
    "SELECT id,state,manifest FROM identity_runs WHERE scope=? AND state!='review'",
  ).get(scopeKey(config)) as (Run & {state: 'applying' | 'stable'}) | undefined;
  const mode = (config: IdentityScope): 'legacy' | 'applying' | 'stable' => active(config)?.state ?? 'legacy';
  const aliases = (config: IdentityScope): Alias[] => {
    const run = active(config);
    if (run?.state !== 'stable') return [];
    const {preview} = JSON.parse(run.manifest) as Manifest;
    return preview.bookmarks.flatMap(({kind, from, to}) => to ? [{kind, from, to}] : []);
  };
  const hasApplying = () => !!db.prepare("SELECT 1 FROM identity_runs WHERE state='applying' LIMIT 1").get();
  function priorEvidence(config: IdentityScope, renames: RenameEvidence) {
    const anchored = new Set<string>();
    for (const hint of renames) {
      if (!hint.priorPlanId) continue;
      const prior = db.prepare("SELECT manifest FROM identity_runs WHERE id=? AND scope=?")
        .get(hint.priorPlanId, scopeKey(config)) as {manifest: string} | undefined;
      if (!prior) continue;
      const {preview} = JSON.parse(prior.manifest) as Manifest;
      if (preview.coverage === 'complete' && preview.rows.some(row => row.kind === hint.kind &&
          row.oldId === hint.oldId && row.notePath === hint.oldId && row.hash === hint.baselineHash))
        anchored.add(hint.operationId);
    }
    return anchored;
  }
  async function preview(config: IdentityScope, signal: AbortSignal, renames: RenameEvidence = [], choices?: MigrationChoices) {
    if (active(config)) return blocked('An identity migration is already applying or stable for this scope.');
    const result = await migrationPreview(bb, config, signal, renames, priorEvidence(config, renames), choices);
    const manifest: Manifest = { preview: result, renames, notes: {}, threads: {} };
    const id = randomUUID();
    db.prepare("INSERT INTO identity_runs VALUES (?,?,'review',?)").run(id, scopeKey(config), JSON.stringify(manifest));
    return { ...result, planId: id, decisions: decisions(result) };
  }
  async function apply(config: IdentityScope, id: string, signal: AbortSignal, check: () => Promise<void>) {
    const run = db.prepare('SELECT id,state,manifest FROM identity_runs WHERE id=? AND scope=?').get(id, scopeKey(config)) as Run | undefined;
    if (!run) return blocked('The reviewed plan does not belong to the selected scope.');
    if (run.state === 'stable') return { state: 'stable' as const };
    const manifest = JSON.parse(run.manifest) as Manifest;
    const { preview } = manifest;
    if (run.state === 'review' && preview.version !== migrationPreviewVersion)
      throw new OutdatedMigrationReview();
    if (preview.coverage !== 'complete' || decisions(preview)) return blocked('The preview has unresolved evidence or mappings.');
    const save = () => db.prepare('UPDATE identity_runs SET manifest=? WHERE id=?').run(JSON.stringify(manifest), id);
    const { source: vaultId, scope } = preview;
    const adapter = new ObsidianBackend(bb.sdk, { vaultId, root: scope.root, folder: scope.projectsFolder,
      areasFolder: scope.areasFolder }, undefined, 'stable');
    const currentNote = (path: string, operationId?: string) => vaultRpc(bb.sdk, 'noteEvidence',
      { vaultId, path, ...(operationId ? { operationId } : {}) }, signal).then(noteEvidence.parse);
    const desired = (row: Preview['rows'][number]) => ({
      id: row.proposedId!,
      ...(row.proposedAreaId === undefined ? {} : { area: row.proposedAreaId }),
    });
    const matches = (props: Record<string, unknown>, fields: Record<string, unknown>) =>
      Object.entries(fields).every(([key, value]) => isDeepStrictEqual(props[key], value));
    const fence = async () => {
      signal.throwIfAborted();
      await check();
      await adapter.checkAccess(signal);
    };
    const verifyLinks = async (requireStable: boolean) => {
      const actual = await readThreadReferences(bb.sdk, vaultId, signal);
      const reviewed = new Map(preview.links.map(link => [threadChoiceKey(link), link]));
      if (actual.warnings.length || actual.refs.length !== reviewed.size) return blocked('Thread reference coverage changed.');
      for (const link of actual.refs) {
        const key = threadChoiceKey(link);
        const expected = reviewed.get(key);
        if (!expected || link.archived !== expected.archived ||
            (link.id !== expected.proposedId && (requireStable || link.id !== expected.id)) ||
            (expected.decision === 'explicit_reassignment' && link.id !== expected.id && !manifest.threads[key]))
          return blocked('A reviewed thread reference changed independently.');
      }
    };
    await fence();
    if (preview.explicitChoices?.threadReassignments.length) await verifyLinks(false);
    if (run.state === 'review') {
      if (hasApplying()) return blocked('Another reviewed migration is still applying.');
      const observed = await migrationPreview(bb, config, signal, manifest.renames, priorEvidence(config, manifest.renames), preview.explicitChoices);
      const ordered = (p: Manifest['preview']) => ({
        ...p, rows: [...p.rows].sort((a,b) => a.oldId.localeCompare(b.oldId)),
        links: [...p.links].sort((a,b) => threadChoiceKey(a).localeCompare(threadChoiceKey(b))),
        bookmarks: [...p.bookmarks].sort((a,b) => a.from.localeCompare(b.from)),
      });
      if (!isDeepStrictEqual(ordered(preview), ordered(observed))) return blocked('The reviewed inventory or references changed. Review a fresh preview.');
      await fence();
      db.prepare("UPDATE identity_runs SET state='applying' WHERE id=? AND state='review'").run(id);
    }
    const reconcileNote = async (row: Preview['rows'][number], steps: NoteSteps) => {
      const path = row.notePath!;
      const fields = desired(row);
      // Validate previously completed stages against the last checked version.
      // A later property save legitimately changes the earlier stage's hash.
      const entered = steps.area ? 'area' : steps.id ? 'id' : undefined;
      if (entered) {
        const step = steps[entered]!;
        const note = await currentNote(path, step.operationId);
        const previous = entered === 'area' ? steps.id?.savedHash ?? row.hash : row.hash;
        if (note.receipt === 'not_saved' && note.hash === previous && !step.savedHash) {
          delete steps[entered];
          save();
        } else {
          const priorFields = entered === 'area' ? fields : { id: fields.id };
          if (note.receipt !== 'saved_locally_pending_sync' || !matches(note.properties, priorFields) ||
              (step.savedHash && step.savedHash !== note.hash))
            return blocked('A note save needs reconciliation. Inspect its recorded operation before continuing.');
          step.savedHash = note.hash;
          save();
        }
      }
    };
    if (run.state === 'applying' && preview.explicitChoices) {
      const paths = new Set([
        ...preview.explicitChoices.areaAssignments.flatMap(choice => [choice.projectPath, choice.targetAreaPath]),
        ...preview.explicitChoices.threadReassignments.map(choice => choice.targetPath),
      ]);
      for (const row of preview.rows) {
        if (!row.notePath || !paths.has(row.notePath)) continue;
        const steps = manifest.notes[row.notePath] ?? {};
        await reconcileNote(row, steps);
        const current = await currentNote(row.notePath);
        if (current.hash !== (steps.area?.savedHash ?? steps.id?.savedHash ?? row.hash))
          return blocked('A note involved in an explicit choice changed during migration.');
      }
    }
    for (const row of preview.rows) {
      const path = row.notePath!;
      const fields = desired(row);
      const steps = manifest.notes[path] ??= {};
      await reconcileNote(row, steps);
      let expectedHash = row.hash;
      const stages = (['id', 'area'] as const).filter(field => fields[field] !== undefined);
      for (const field of stages) {
        const completed = steps[field]?.savedHash;
        if (completed) { expectedHash = completed; continue; }
        const note = await currentNote(path);
        if (note.hash !== expectedHash) return blocked('A reviewed note version changed.');
        const set = { [field]: fields[field]! };
        if (matches(note.properties, set)) continue;
        await fence();
        const step: NoteStep = { operationId: randomUUID() };
        steps[field] = step;
        save();
        const receipt = noteSaveReceipt.parse(await vaultRpc(bb.sdk, 'writeProperties',
          { vaultId, path, expectedHash: note.hash, set, operationId: step.operationId }, signal));
        if (receipt.operationId !== step.operationId) return blocked('The note save receipt did not match.');
        if (receipt.outcome === 'not_saved') {
          delete steps[field];
          save();
          return blocked('A note write was refused. Inspect the reviewed note before continuing.');
        }
        const after = await currentNote(path, step.operationId);
        if (after.receipt !== 'saved_locally_pending_sync' || !matches(after.properties, set))
          return blocked('A note save needs reconciliation. Inspect its recorded operation before continuing.');
        step.savedHash = expectedHash = after.hash;
        save();
      }
    }
    const verifyInventory = async () => {
      const { projects, areas } = await adapter.readBoth(signal);
      if (!projects.complete || !areas.complete || projects.projects.length + areas.areas.length !== preview.rows.length)
        return blocked('The stable inventory does not match the reviewed inventory.');
      const records = { project: new Map(projects.projects.map(row => [row.id,row])), area: new Map(areas.areas.map(row => [row.id,row])) };
      for (const row of preview.rows) {
        const note = await currentNote(row.notePath!);
        if (note.hash !== (manifest.notes[row.notePath!]?.area?.savedHash ?? manifest.notes[row.notePath!]?.id?.savedHash ?? row.hash) || !matches(note.properties, desired(row)))
          return blocked('A reviewed note changed during migration.');
        const record = records[row.kind].get(row.proposedId!);
        if (!record || record.notePath !== row.notePath ||
            (row.kind === 'project' && ('areaId' in record ? record.areaId : undefined) !== row.proposedAreaId))
          return blocked('A stable note or Area assignment is unavailable or changed.');
      }
    };
    await verifyInventory();
    await verifyLinks(false);
    for (const link of preview.links) {
      const key = threadChoiceKey(link);
      const read = async () => {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: link.threadId, signal });
        const ref = reference.safeParse(metadata[link.kind]).data;
        return ref?.source === vaultId ? ref.id : undefined;
      };
      await fence();
      const before = await read();
      if (before === link.proposedId) {
        if (link.decision === 'explicit_reassignment' && before !== link.id && !manifest.threads[key])
          return blocked('A reviewed thread reference changed independently.');
        manifest.threads[key] = 'verified';
        save();
        continue;
      }
      if (before !== link.id || manifest.threads[key]) return blocked('A thread write needs reconciliation. Inspect the original association.');
      manifest.threads[key] = 'entered';
      save();
      await bb.sdk.threads.updatePluginMetadata({ threadId: link.threadId, set: { [link.kind]: { source: vaultId, id: link.proposedId! } }, signal });
      if (await read() !== link.proposedId) return blocked('A thread write needs reconciliation. Inspect the original association.');
      manifest.threads[key] = 'verified';
      save();
    }
    await fence();
    await verifyInventory();
    await verifyLinks(true);
    await check();
    db.prepare("UPDATE identity_runs SET state='stable' WHERE id=? AND state='applying'").run(id);
    return { state: 'stable' as const };
  }
  function receipt(config: IdentityScope, id: string) {
    const run = db.prepare('SELECT id,state,manifest FROM identity_runs WHERE id=? AND scope=?').get(id, scopeKey(config)) as Run | undefined;
    if (!run) return blocked('The reviewed plan does not belong to the selected scope.');
    const manifest = JSON.parse(run.manifest) as Manifest;
    return { planId: id, state: run.state, notes: manifest.notes, threads: manifest.threads };
  }
  return { mode, aliases, hasApplying, preview, apply, receipt };
}
