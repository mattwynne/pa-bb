import { randomUUID } from 'node:crypto';
import { GtdError, listInput, snapshotSchema, statuses } from './model.ts';
import type { BackendSelection, ListInput, Project, ProjectPage, ProjectSnapshot } from './model.ts';

type Listing = { key: string; owner: string; status: string; snapshot: ProjectSnapshot; rows: Project[]; offset: number; at: number };
export class Projects {
  private listings = new Map<string, Listing>();
  private reservations = 0;
  private stopped = false;
  constructor(private select: () => Promise<BackendSelection>, private now = Date.now) {}
  stop() { this.stopped = true; this.listings.clear(); }
  async list(raw: ListInput, signal: AbortSignal, owner: string): Promise<ProjectPage> {
    const input = listInput.parse(raw);
    if (this.stopped || signal.aborted) throw new GtdError('cancelled');
    for (const [id, listing] of this.listings) if (this.now() - listing.at > 300000) this.listings.delete(id);
    const selected = await this.select();
    let token = input.cursor;
    let listing = token ? this.listings.get(token) : undefined;
    if (token) {
      if (!listing || listing.owner !== owner || listing.key !== selected.key || (input.status !== undefined && input.status !== listing.status)) throw new GtdError('cursor_expired');
      // Claim synchronously: two calls cannot consume the same continuation.
      this.listings.delete(token);
      this.reservations++;
    } else {
      if (this.listings.size + this.reservations >= 4) throw new GtdError('capacity');
      this.reservations++;
    }
    try {
      if (!listing) {
        const rawSnapshot = await selected.backend.readProjects(signal);
        const parsed = snapshotSchema.safeParse(rawSnapshot);
        if (!parsed.success) throw new GtdError('invalid_source');
        const snapshot = parsed.data;
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024) throw new GtdError('invalid_source');
        const seen = new Set<string>();
        snapshot.projects = snapshot.projects.filter(project => {
          if (!seen.has(project.id)) { seen.add(project.id); return true; }
          snapshot.complete = false;
          if (!snapshot.warnings.includes('duplicate_id')) snapshot.warnings.push('duplicate_id');
          return false;
        });
        const status = input.status ?? 'all';
        const rows = snapshot.projects.filter(project => status === 'all' || project.status === status).sort((a, b) =>
          statuses.indexOf(a.status) - statuses.indexOf(b.status) || a.title.localeCompare(b.title, 'en') || a.id.localeCompare(b.id, 'en'));
        listing = { key: selected.key, owner, status, snapshot, rows, offset: 0, at: this.now() };
      }
      await selected.backend.checkAccess(signal);
      if (this.stopped || signal.aborted) throw new GtdError('cancelled');
      // Settings can change while an adapter reads. Never publish the old selection as current.
      if ((await this.select()).key !== selected.key) throw new GtdError('cursor_expired');
      const { snapshot } = listing;
      const counts = { active: 0, deferred: 0, someday: 0, done: 0 };
      for (const project of snapshot.projects) counts[project.status]++;
      const page: ProjectPage = {
        source: snapshot.source, projects: [], coverage: snapshot.complete ? 'complete' : 'partial', warnings: snapshot.warnings,
        totalProjects: snapshot.complete ? snapshot.projects.length : null,
        matchedProjects: snapshot.complete ? listing.rows.length : null,
        counts: snapshot.complete ? counts : null, nextCursor: null,
        consistency: 'Per-project local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.',
      };
      token = randomUUID();
      while (page.projects.length < (input.limit ?? 200) && listing.offset < listing.rows.length) {
        const project = listing.rows[listing.offset];
        // Reserve room for the continuation token before bounding UTF-8 output.
        if (Buffer.byteLength(JSON.stringify({ ...page, projects: [...page.projects, project], nextCursor: token })) > 48000) break;
        page.projects.push(project); listing.offset++;
      }
      if (listing.offset < listing.rows.length) { listing.at = this.now(); this.listings.set(token, listing); page.nextCursor = token; }
      return page;
    } finally { this.reservations--; }
  }
}
