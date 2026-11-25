import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { reference } from '../contract.ts';
import { ObsidianBackend, noteEvidence, vaultRpc, relativeFolder, type PreviewEvidence } from '../adapters/obsidian.ts';
import type { Project, Area } from './model.ts';

import { canonicalIds, newStableId, stableIds, scopeKey, type IdentityScope, type Kind } from './identity.ts';
export { stableIds } from './identity.ts';
export const migrationPreviewVersion = 3;
type Row = { kind: Kind; oldId: string; notePath: string | null; proposedPath: string | null; existingId: unknown; proposedId: string | null; decisions: string[]; declaration?: unknown; legacyAreaId?: string; proposedAreaId?: string; hash?: string };
type Thread = { threadId: string; archived: boolean; id: string; kind: Kind };
export const renameEvidence = z.array(z.object({
  kind: z.enum(['project', 'area']), oldId: relativeFolder, operationId: z.string().uuid(),
  baselineHash: noteEvidence.shape.hash,
  priorPlanId: z.string().uuid().optional(),
}).strict()).max(200);
export type RenameEvidence = z.infer<typeof renameEvidence>;
export function planRows(projects: Project[], areas: Area[], evidence: PreviewEvidence, reserve: (kind: Row['kind'], oldId: string) => string) {
  const rows: Row[] = [];
  for (const [kind, items] of [['project', projects], ['area', areas]] as const) for (const item of items) {
    const owner = item.id.endsWith('/') ? null : item.id;
    const props = owner ? evidence.owners.get(owner) : undefined;
    const row: Row = { kind, oldId: item.id, notePath: owner, proposedPath: owner, existingId: props?.id ?? null, proposedId: null, decisions: [] };
    if (!owner) row.decisions.push('missing_landing_page');
    if (owner && !props) row.decisions.push('unconfirmed_owner');
    if (props && Object.hasOwn(props, 'id')) {
      const parsed = stableIds[kind].safeParse(props.id);
      if (parsed.success) row.proposedId = parsed.data; else row.decisions.push('invalid_existing_id');
    } else if (props) row.proposedId = reserve(kind, item.id);
    if (kind === 'project' && props && Object.hasOwn(props, 'area')) row.declaration = props.area;
    if ((item as Project).areaId) row.legacyAreaId = (item as Project).areaId;
    rows.push(row);
  }
  for (const [key, warning] of [['notePath','ambiguous_owner'],['proposedId','ambiguous_identity']] as const) {
    const seen = new Map<string, Row[]>();
    for (const row of rows) { const v = row[key]; if (v) { const list = seen.get(v) ?? []; list.push(row); seen.set(v,list); } }
    for (const group of seen.values()) if (group.length > 1) for (const row of group) row.decisions.push(warning);
  }
  const byArea = new Map(rows.filter(r => r.kind === 'area').map(r => [r.oldId,r]));
  for (const row of rows.filter(r => r.kind === 'project')) {
    const d = row.declaration;
    if (row.legacyAreaId) {
      const area = byArea.get(row.legacyAreaId);
      if (!area) row.decisions.push('nested_or_missing_area');
      else if (!area.decisions.length && area.proposedId) row.proposedAreaId = area.proposedId;
      else row.decisions.push('area_needs_review');
    } else if (d != null && !(typeof d === 'string' && !d.trim()) && !(Array.isArray(d) && !d.length)) {
      const matched = rows.find(r => r.kind === 'area' && r.existingId === d && !r.decisions.length);
      if (matched?.proposedId) row.proposedAreaId = matched.proposedId; else row.decisions.push('unresolved_declaration');
    }
  }
  return rows;
}
export async function readThreadReferences(sdk: BbPluginApi['sdk'], source: string, signal: AbortSignal, includeAreas = true) {
  const refs: Thread[] = [], warnings = new Set<string>(), seen = new Set<string>();
  const counts = { active: 0, archived: 0 };
  for (const archived of [false,true]) {
    for (let offset = 0; ; ) {
      signal.throwIfAborted();
      if (offset >= 20000) { warnings.add('thread_scan_limit'); break; }
      const page = await sdk.threads.list({ archived, includeHidden: true, offset, limit: 100, signal });
      if (!page.length) break;
      const ids = page.map(t => t.id);
      if (ids.some(id => seen.has(id))) { warnings.add('thread_listing_changed'); break; }
      for (const id of ids) seen.add(id);
      counts[archived ? 'archived' : 'active'] += ids.length;
      const data = await sdk.threads.experimental_listPluginMetadata({ threadIds: ids });
      const returned = new Set<string>();
      for (const t of data.threads) {
        if (!ids.includes(t.threadId) || returned.has(t.threadId)) throw new Error('Unexpected metadata response');
        returned.add(t.threadId);
        for (const kind of ['project', 'area'] as const) {
          if ((!includeAreas && kind === 'area') || t.metadata[kind] === undefined) continue;
          const ref = reference.safeParse(t.metadata[kind]);
          if (!ref.success) warnings.add('invalid_thread_reference');
          else if (ref.data.source === source) refs.push({ threadId: t.threadId, archived, id: ref.data.id, kind });
        }
      }
      // The BB SDK returns sparse metadata: an omitted thread has no plugin metadata.
      offset += page.length;
    }
  }
  return { refs, warnings: [...warnings], counts };
}
const receiptSchema = z.object({
  vaultId: z.string(), path: relativeFolder, destination: relativeFolder, operationId: z.string(),
  outcome: z.literal('moved_locally_pending_sync'),
  legacy: z.object({ expectedHash: noteEvidence.shape.hash.optional() }).optional(),
});

export async function migrationPreview(bb: BbPluginApi, config: IdentityScope, signal: AbortSignal, renames: RenameEvidence = [], anchored: ReadonlySet<string> = new Set()) {
  const [vaultId, ...segments] = config.vaultId.split('/'), root = segments.join('/');
  const scope = scopeKey(config);
  const evidence: PreviewEvidence = { owners: new Map(), entries: new Set() };
  const adapter = new ObsidianBackend(bb.sdk, { vaultId, root, folder: config.projectsFolder, areasFolder: config.areasFolder }, evidence);
  const { projects: project, areas: area } = await adapter.readBoth(signal);
  const threads = await readThreadReferences(bb.sdk, vaultId, signal);
  const db = bb.storage.database();
  // Reservations live in GTD storage. Preview performs no vault or BB metadata writes.
  // Keep previous reservations available as historical evidence. The current
  // format has its own reservations so an unassigned old proposal cannot leak into a new review.
  db.exec('CREATE TABLE IF NOT EXISTS migration_proposals_v2 (scope TEXT, kind TEXT, old_id TEXT, proposal TEXT NOT NULL UNIQUE, PRIMARY KEY(scope, kind, old_id))');
  const rows = planRows(project.projects, area.areas, evidence, (kind,oldId) => {
    db.prepare('INSERT OR IGNORE INTO migration_proposals_v2 VALUES (?,?,?,?)').run(scope,kind,oldId,newStableId(kind));
    const row = db.prepare('SELECT proposal FROM migration_proposals_v2 WHERE scope=? AND kind=? AND old_id=?')
      .get(scope,kind,oldId) as {proposal: string} | undefined;
    return canonicalIds[kind].parse(row?.proposal);
  });
  const warnings = new Set([...project.warnings, ...area.warnings, ...threads.warnings]);
  for (const row of rows) {
    if (!row.notePath) continue;
    try {
      const note = noteEvidence.parse(await vaultRpc(bb.sdk, 'noteEvidence', { vaultId, path: row.notePath }, signal));
      const props = evidence.owners.get(row.notePath);
      if (!props || ['id', 'area', 'status'].some(field => JSON.stringify(props[field]) !== JSON.stringify(note.properties[field])))
        throw new Error('Inventory changed');
      row.hash = note.hash;
    } catch {
      signal.throwIfAborted();
      warnings.add('note_evidence_unavailable');
      row.decisions.push('note_version_unconfirmed');
    }
  }
  const aliasKey = (kind: Kind, id: string) => JSON.stringify([kind, id]);
  const byOld = new Map(rows.map(row => [aliasKey(row.kind, row.oldId), row]));
  const byStable = new Map(rows.filter(row => row.proposedId).map(row => [aliasKey(row.kind, row.proposedId!), row]));
  const renameMappings = [];
  const renamed = new Map<string, Row>();
  const reviewedAliases = new Set(renames.map(hint => aliasKey(hint.kind, hint.oldId)));
  for (const hint of renames) {
    const key = aliasKey(hint.kind, hint.oldId);
    let receipt: z.infer<typeof receiptSchema> | undefined;
    try { receipt = receiptSchema.safeParse(await vaultRpc(bb.sdk, 'moveReceipt', { vaultId, operationId: hint.operationId }, signal)).data; }
    catch { signal.throwIfAborted(); }
    const target = receipt && byOld.get(aliasKey(hint.kind, receipt.destination));
    // Legacy receipts carrying the checked source hash can establish lineage
    // when the current destination still has that version.
    const verified = !!receipt && !!target && !target.decisions.length && receipt.vaultId === vaultId &&
      receipt.operationId === hint.operationId && receipt.path === hint.oldId && receipt.destination !== hint.oldId &&
      (receipt.legacy?.expectedHash === hint.baselineHash || anchored.has(hint.operationId)) && target.hash === hint.baselineHash && !renamed.has(key);
    if (verified) renamed.set(key, target);
    else warnings.add('rename_unverified');
    renameMappings.push({ ...hint, destination: receipt?.destination ?? null, proposedId: verified ? target.proposedId : null,
      decision: verified ? 'verified_rename' : 'rename_unverified' });
  }
  for (const row of rows) {
    if (row.kind !== 'project') continue;
    const declaration = row.declaration;
    const raw = row.legacyAreaId ?? (typeof declaration === 'string' ? declaration : undefined);
    const key = raw && aliasKey('area', raw);
    if (!key || !reviewedAliases.has(key)) continue;
    const target = renamed.get(key);
    if (target && target.proposedId) {
      row.proposedAreaId = target.proposedId;
      row.decisions = row.decisions.filter(d => d !== 'unresolved_declaration' && d !== 'nested_or_missing_area' && d !== 'area_needs_review');
    } else {
      delete row.proposedAreaId;
      row.decisions.push('area_rename_unverified');
    }
  }
  const links = threads.refs.map(ref => {
    const key = aliasKey(ref.kind, ref.id);
    const moved = renamed.get(key);
    const match = moved ?? (reviewedAliases.has(key) ? undefined : byOld.get(key) ?? byStable.get(key));
    return { ...ref, proposedId: match?.proposedId ?? null, decision: !match ? (reviewedAliases.has(key) ? 'rename_unverified' : 'unmatched_legacy_reference') :
      match.decisions.length ? 'owner_needs_review' : moved ? 'verified_rename' : null };
  });
  const bookmarks = [
    ...rows.filter(row => !reviewedAliases.has(aliasKey(row.kind, row.oldId))).map(row => ({
      kind: row.kind, from: row.oldId, to: row.decisions.length ? null : row.proposedId,
      decision: row.decisions.length ? 'owner_needs_review' : null,
    })),
    ...renameMappings.map(row => ({ kind: row.kind, from: row.oldId, to: row.proposedId, decision: row.decision })),
  ];
  await adapter.checkAccess(signal);
  return { version: migrationPreviewVersion, mode: 'preview_only' as const, source: vaultId, scope: {root, projectsFolder: config.projectsFolder, areasFolder: config.areasFolder},
    coverage: warnings.size ? 'partial' as const : 'complete' as const, warnings: [...warnings], threadsExamined: threads.counts,
    rows, links, bookmarks, renameMappings, malformedFrontmatter: [...(project.malformedFrontmatter ?? []), ...(area.malformedFrontmatter ?? [])] };
}
export type Preview = Awaited<ReturnType<typeof migrationPreview>>;
