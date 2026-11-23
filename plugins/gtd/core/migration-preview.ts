import { randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { reference } from '../contract.ts';
import { ObsidianBackend, relativeFolder, type PreviewEvidence } from '../adapters/obsidian.ts';
import type { Project, Area } from './model.ts';

const uuid4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const stableIds = { project: z.string().regex(new RegExp(`^project_${uuid4}$`)), area: z.string().regex(new RegExp(`^area_${uuid4}$`)) };
type Row = { kind: 'project' | 'area'; oldId: string; notePath: string | null; proposedPath: string; existingId: unknown; proposedId: string | null; decisions: string[]; declaration?: unknown; legacyAreaId?: string; proposedAreaId?: string };
type Thread = { threadId: string; archived: boolean; id: string };
export function planRows(projects: Project[], areas: Area[], evidence: PreviewEvidence, folders: {project: string; area: string}, reserve: (kind: Row['kind'], oldId: string) => string) {
  const rows: Row[] = [];
  for (const [kind, items] of [['project', projects], ['area', areas]] as const) for (const item of items) {
    const owner = item.id.endsWith('/') ? null : item.id;
    const props = owner ? evidence.owners.get(owner) : undefined;
    const stem = item.id.replace(/\/$/, '').split('/').at(-1)!;
    const name = item.id.endsWith('/') ? stem + '.md' : stem;
    const status = (item as Project).status;
    const path = kind === 'project' ? `${folders.project}/${status[0].toUpperCase()+status.slice(1)}/${name}` : `${folders.area}/${name}`;
    const row: Row = { kind, oldId: item.id, notePath: owner, proposedPath: path, existingId: props?.id ?? null, proposedId: null, decisions: [] };
    if (!owner) row.decisions.push('missing_landing_page');
    if (owner && !props) row.decisions.push('unconfirmed_owner');
    if (!relativeFolder.safeParse(path).success) row.decisions.push('invalid_destination');
    if (path !== owner && evidence.entries.has(path)) row.decisions.push('occupied_destination');
    if (props && Object.hasOwn(props, 'id')) {
      const parsed = stableIds[kind].safeParse(props.id);
      if (parsed.success) row.proposedId = parsed.data; else row.decisions.push('invalid_existing_id');
    } else row.proposedId = reserve(kind, item.id);
    if (kind === 'project' && props && Object.hasOwn(props, 'area')) row.declaration = props.area;
    if ((item as Project).areaId) row.legacyAreaId = (item as Project).areaId;
    rows.push(row);
  }
  for (const [key, warning] of [['proposedPath','destination_collision'],['proposedId','ambiguous_identity']] as const) {
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
export async function readThreadReferences(sdk: BbPluginApi['sdk'], source: string, signal: AbortSignal) {
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
      for (const t of data.threads) {
        if (!ids.includes(t.threadId)) throw new Error('Unexpected metadata response');
        if (t.metadata.project === undefined) continue;
        const ref = reference.safeParse(t.metadata.project);
        if (!ref.success) warnings.add('invalid_thread_reference');
        else if (ref.data.source === source) refs.push({ threadId: t.threadId, archived, id: ref.data.id });
      }
      offset += page.length;
    }
  }
  return { refs, warnings: [...warnings], counts };
}
export async function migrationPreview(bb: BbPluginApi, config: { vaultId: string; projectsFolder: string; areasFolder: string }, signal: AbortSignal) {
  const [vaultId, ...segments] = config.vaultId.split('/'), root = segments.join('/');
  const scope = JSON.stringify([config.vaultId,config.projectsFolder,config.areasFolder]);
  const evidence: PreviewEvidence = { owners: new Map(), entries: new Set() };
  const adapter = (folder: string) => new ObsidianBackend(bb.sdk, { vaultId, root, folder, areasFolder: config.areasFolder }, undefined, evidence);
  const project = await adapter(config.projectsFolder).readProjects(signal);
  const area = await adapter(config.areasFolder).readAreas(signal);
  const threads = await readThreadReferences(bb.sdk, vaultId, signal);
  // Revalidate the same authority/publication after the independent BB metadata read.
  if (!evidence.proof) throw new Error('Missing preview authority');
  await adapter(config.areasFolder).readAreas(signal);
  const folder = (name: string) => [root,name].filter(Boolean).join('/');
  const db = bb.storage.database();
  // Reservations are private preview proposals, never proof of file identity for apply.
  db.exec('CREATE TABLE IF NOT EXISTS migration_proposals_v1 (scope TEXT, kind TEXT, old_id TEXT, proposal TEXT NOT NULL UNIQUE, PRIMARY KEY(scope, kind, old_id))');
  const rows = planRows(project.projects, area.areas, evidence, { project: folder(config.projectsFolder), area: folder(config.areasFolder) }, (kind,oldId) => {
    db.prepare('INSERT OR IGNORE INTO migration_proposals_v1 VALUES (?,?,?,?)').run(scope,kind,oldId,`${kind}_${randomUUID()}`);
    return (db.prepare('SELECT proposal FROM migration_proposals_v1 WHERE scope=? AND kind=? AND old_id=?').get(scope,kind,oldId) as {proposal: string}).proposal;
  });
  const warnings = [...new Set([...project.warnings,...area.warnings,...threads.warnings])];
  const links = threads.refs.map(ref => {
    const match = rows.find(r => r.kind === 'project' && r.oldId === ref.id);
    return { ...ref, proposedId: match?.proposedId ?? null, decision: !match ? 'unmatched_legacy_reference' : match.decisions.length ? 'project_needs_review' : null };
  });
  return { version: 1, mode: 'preview_only', source: vaultId, scope: {root, projectsFolder: config.projectsFolder, areasFolder: config.areasFolder}, coverage: warnings.length ? 'partial' : 'complete', warnings, threadsExamined: threads.counts, rows, links };
}
