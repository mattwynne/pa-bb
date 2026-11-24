import { randomUUID } from 'node:crypto';
import { GtdError, areaListInput, areaSnapshotSchema } from './model.ts';
import type { AreaBackendSelection, AreaListInput, Area, AreaPage, AreaSnapshot } from './model.ts';

export const compareAreas = (a: Area, b: Area) =>
  a.title.localeCompare(b.title, 'en') || a.id.localeCompare(b.id, 'en');

export function normalizeAreaSnapshot(raw: unknown): AreaSnapshot {
  const parsed = areaSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new GtdError('invalid_source');
  const snapshot = parsed.data;
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024) throw new GtdError('invalid_source');
  const seen = new Set<string>();
  snapshot.areas = snapshot.areas.filter(area => {
    if (!seen.has(area.id)) { seen.add(area.id); return true; }
    snapshot.complete = false;
    if (!snapshot.warnings.includes('duplicate_id')) snapshot.warnings.push('duplicate_id');
    return false;
  });
  return snapshot;
}

type Listing = { key: string; owner: string; snapshot: AreaSnapshot; rows: Area[]; offset: number; at: number };
export class Areas {
  private listings = new Map<string, Listing>();
  private reservations = 0;
  private stopped = false;
  constructor(private select: () => Promise<AreaBackendSelection>, private now = Date.now) {}
  stop() { this.stopped = true; this.listings.clear(); }
  async list(raw: AreaListInput, signal: AbortSignal, owner: string): Promise<AreaPage> {
    const input = areaListInput.parse(raw);
    if (this.stopped || signal.aborted) throw new GtdError('cancelled');
    for (const [id, listing] of this.listings) if (this.now() - listing.at > 300000) this.listings.delete(id);
    const selected = await this.select();
    let token = input.cursor;
    let listing = token ? this.listings.get(token) : undefined;
    if (token) {
      if (!listing || listing.owner !== owner || listing.key !== selected.key) throw new GtdError('cursor_expired');
      this.listings.delete(token);
    } else if (this.listings.size + this.reservations >= 4) throw new GtdError('capacity');
    this.reservations++;
    try {
      if (!listing) {
        const snapshot = normalizeAreaSnapshot(await selected.backend.readAreas(signal));
        const rows = [...snapshot.areas].sort(compareAreas);
        listing = { key: selected.key, owner, snapshot, rows, offset: 0, at: this.now() };
      }
      await selected.backend.checkAccess(signal);
      if (this.stopped || signal.aborted) throw new GtdError('cancelled');
      if ((await this.select()).key !== selected.key) throw new GtdError('cursor_expired');
      const { snapshot } = listing;
      const page: AreaPage = {
        source: snapshot.source, areas: [], coverage: snapshot.complete ? 'complete' : 'partial', warnings: snapshot.warnings,
        ...(snapshot.malformedFrontmatter ? { malformedFrontmatter: snapshot.malformedFrontmatter } : {}),
        totalAreas: snapshot.complete ? snapshot.areas.length : null, nextCursor: null,
        consistency: 'Per-area local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.',
      };
      token = randomUUID();
      while (page.areas.length < (input.limit ?? 200) && listing.offset < listing.rows.length) {
        const area = listing.rows[listing.offset];
        if (Buffer.byteLength(JSON.stringify({ ...page, areas: [...page.areas, area], nextCursor: token })) > 48000) break;
        page.areas.push(area); listing.offset++;
      }
      if (listing.offset < listing.rows.length) { listing.at = this.now(); this.listings.set(token, listing); page.nextCursor = token; }
      return page;
    } finally { this.reservations--; }
  }
}
