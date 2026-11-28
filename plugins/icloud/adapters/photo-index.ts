import type Database from 'better-sqlite3';
import { CloudError } from '../core/ports.ts';
import { materialize } from './icloud-photo-records.ts';
import type { AssetRecord, MasterRecord, Projection } from './icloud-photo-records.ts';
import type { PhotoOrder } from './cloudkit-photos.ts';

type Row = { asset: string; master: string | null };
type IndexState = {
  generation: number; rank: number | null; token: string | null;
  total: number | null; updated: string | null; anchor: string | null;
};

export class PhotoIndex {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS photo_library_index (
        scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, rank INTEGER,
        token TEXT, total INTEGER, updated TEXT, anchor TEXT
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS photo_library_masters (
        scope TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS photo_library_assets (
        scope TEXT NOT NULL, id TEXT NOT NULL, generation INTEGER NOT NULL, master TEXT NOT NULL,
        created TEXT, payload TEXT NOT NULL, PRIMARY KEY (scope, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS photo_library_assets_order ON photo_library_assets(scope, generation, created, id);
      CREATE INDEX IF NOT EXISTS photo_library_assets_master ON photo_library_assets(scope, master);
      CREATE TABLE IF NOT EXISTS photo_library_month_counts (
        scope TEXT NOT NULL, generation INTEGER NOT NULL, month TEXT NOT NULL, n INTEGER NOT NULL,
        PRIMARY KEY (scope, generation, month)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS photo_library_month_insert AFTER INSERT ON photo_library_assets BEGIN
        INSERT INTO photo_library_month_counts VALUES (NEW.scope, NEW.generation, coalesce(substr(NEW.created, 1, 7), ''), 1)
        ON CONFLICT(scope, generation, month) DO UPDATE SET n = n + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS photo_library_month_delete AFTER DELETE ON photo_library_assets BEGIN
        UPDATE photo_library_month_counts SET n = n - 1
          WHERE scope = OLD.scope AND generation = OLD.generation AND month = coalesce(substr(OLD.created, 1, 7), '');
        DELETE FROM photo_library_month_counts
          WHERE scope = OLD.scope AND generation = OLD.generation AND month = coalesce(substr(OLD.created, 1, 7), '') AND n = 0;
      END;
      CREATE TRIGGER IF NOT EXISTS photo_library_month_move AFTER UPDATE OF generation, created ON photo_library_assets
      WHEN OLD.generation <> NEW.generation OR substr(OLD.created, 1, 7) IS NOT substr(NEW.created, 1, 7) BEGIN
        UPDATE photo_library_month_counts SET n = n - 1
          WHERE scope = OLD.scope AND generation = OLD.generation AND month = coalesce(substr(OLD.created, 1, 7), '');
        DELETE FROM photo_library_month_counts
          WHERE scope = OLD.scope AND generation = OLD.generation AND month = coalesce(substr(OLD.created, 1, 7), '') AND n = 0;
        INSERT INTO photo_library_month_counts VALUES (NEW.scope, NEW.generation, coalesce(substr(NEW.created, 1, 7), ''), 1)
        ON CONFLICT(scope, generation, month) DO UPDATE SET n = n + 1;
      END;
    `);
  }

  state(scope: string): IndexState | undefined {
    return this.db.prepare('SELECT generation, rank, token, total, updated, anchor FROM photo_library_index WHERE scope = ?').get(scope) as IndexState | undefined;
  }

  begin(scope: string, total: number) {
    this.db.prepare(`
      INSERT INTO photo_library_index (scope, generation, rank, total) VALUES (?, 1, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET generation = generation + 1, rank = excluded.rank, total = excluded.total,
        token = NULL, updated = NULL, anchor = NULL
    `).run(scope, Math.max(0, total - 1), total);
    return this.state(scope)!;
  }

  masterFor(scope: string, id: string) {
    return (this.db.prepare('SELECT master FROM photo_library_assets WHERE scope = ? AND id = ?').get(scope, id) as { master: string } | undefined)?.master ?? null;
  }

  hasMaster(scope: string, id: string) {
    return !!this.db.prepare('SELECT 1 FROM photo_library_masters WHERE scope = ? AND id = ?').get(scope, id);
  }

  apply(scope: string, previous: IndexState, records: Projection, next: Pick<IndexState, 'rank' | 'token' | 'anchor'>) {
    const write = this.db.transaction(() => {
      // A checkpoint belongs to the exact scan/delta page that was read.
      // Matching the old cursor also fences a stale job or plugin generation.
      const saved = this.db.prepare(`
        UPDATE photo_library_index SET rank = ?, token = ?, anchor = ?
        WHERE scope = ? AND generation = ? AND rank IS ? AND token IS ? AND updated IS ? AND anchor IS ?
      `).run(next.rank, next.token, next.anchor, scope, previous.generation, previous.rank, previous.token, previous.updated, previous.anchor);
      if (!saved.changes) throw new CloudError('interrupted');
      const master = this.db.prepare(`INSERT INTO photo_library_masters VALUES (?, ?, ?)
        ON CONFLICT(scope, id) DO UPDATE SET payload = excluded.payload`);
      const asset = this.db.prepare(`INSERT INTO photo_library_assets (scope, id, generation, master, created, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, id) DO UPDATE SET generation = excluded.generation, master = excluded.master,
          created = excluded.created, payload = excluded.payload`);
      for (const row of records.masters) master.run(scope, row.id, JSON.stringify(row));
      for (const row of records.assets) asset.run(scope, row.id, previous.generation, row.master, row.created, JSON.stringify(row));
      const removeAsset = this.db.prepare('DELETE FROM photo_library_assets WHERE scope = ? AND id = ?');
      const removeMaster = this.db.prepare('DELETE FROM photo_library_masters WHERE scope = ? AND id = ?');
      const removeMasterAssets = this.db.prepare('DELETE FROM photo_library_assets WHERE scope = ? AND master = ?');
      for (const id of [...records.deletedMasters, ...records.deletedUnknown]) {
        removeMasterAssets.run(scope, id);
        removeMaster.run(scope, id);
      }
      for (const id of [...records.deletedAssets, ...records.deletedUnknown]) removeAsset.run(scope, id);
    });
    write();
    return { ...previous, ...next };
  }

  indexed(scope: string, current = this.state(scope)) {
    if (!current) return 0;
    return (this.db.prepare('SELECT coalesce(sum(n), 0) AS n FROM photo_library_month_counts WHERE scope = ? AND generation = ?')
      .get(scope, current.generation) as { n: number }).n;
  }

  finish(scope: string, state: IndexState, updated: string, total: number) {
    const save = this.db.prepare(`UPDATE photo_library_index SET rank = NULL, updated = ?, total = ?, anchor = NULL
      WHERE scope = ? AND generation = ? AND rank IS ? AND token IS ? AND updated IS ?`)
      .run(updated, total, scope, state.generation, state.rank, state.token, state.updated);
    if (!save.changes) throw new CloudError('interrupted');
  }

  prune(scope: string, generation: number) {
    // Bounded write transactions keep a large reindex from holding SQLite or
    // the Node event loop while retiring old rows.
    const deleteAssets = this.db.prepare(`DELETE FROM photo_library_assets WHERE scope = ? AND id IN (
      SELECT id FROM photo_library_assets WHERE scope = ? AND generation < ? LIMIT 500
    )`);
    return deleteAssets.run(scope, scope, generation).changes;
  }

  pruneMasters(scope: string, after: string) {
    const page = this.db.prepare('SELECT id FROM photo_library_masters WHERE scope = ? AND id > ? ORDER BY id LIMIT 500').all(scope, after) as { id: string }[];
    const prune = this.db.prepare(`DELETE FROM photo_library_masters WHERE scope = ? AND id BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM photo_library_assets AS a WHERE a.scope = photo_library_masters.scope AND a.master = photo_library_masters.id)`);
    if (page.length) prune.run(scope, page[0].id, page.at(-1)!.id);
    return page.length === 500 ? page.at(-1)!.id : null;
  }

  page(scope: string, order: PhotoOrder, offset: number, limit: number) {
    const state = this.state(scope);
    if (!state) return { total: 0, assets: [] };
    const direction = order === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`
      WITH selected AS MATERIALIZED (
        SELECT id, created FROM photo_library_assets
        WHERE scope = ? AND generation = ?
        ORDER BY created ${direction}, id ${direction} LIMIT ? OFFSET ?
      )
      SELECT a.payload AS asset, m.payload AS master FROM selected s
      JOIN photo_library_assets a ON a.scope = ? AND a.id = s.id
      LEFT JOIN photo_library_masters m ON m.scope = a.scope AND m.id = a.master
      ORDER BY s.created ${direction}, s.id ${direction}
    `).all(scope, state.generation, limit, offset, scope) as Row[];
    return { total: state.total ?? this.indexed(scope, state), assets: rows.map(row => this.materialize(row).value) };
  }

  months(scope: string, order: PhotoOrder) {
    const state = this.state(scope);
    if (!state) return [];
    const direction = order === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`
      SELECT month, n AS count FROM photo_library_month_counts
      WHERE scope = ? AND generation = ? ORDER BY month ${direction}
    `).all(scope, state.generation) as { month: string; count: number }[];
    let offset = 0;
    const months: { month: string; offset: number; count: number }[] = [];
    for (const row of rows) {
      if (row.month) months.push({ month: row.month, offset, count: row.count });
      offset += row.count;
    }
    return months;
  }

  get(scope: string, id: string) {
    const row = this.db.prepare(`
      SELECT a.payload AS asset, m.payload AS master FROM photo_library_assets a
      JOIN photo_library_index i ON i.scope = a.scope AND i.generation = a.generation
      LEFT JOIN photo_library_masters m ON m.scope = a.scope AND m.id = a.master
      WHERE a.scope = ? AND a.id = ?
    `).get(scope, id) as Row | undefined;
    return row ? this.materialize(row) : null;
  }

  private materialize(row: Row) {
    return materialize(JSON.parse(row.asset) as AssetRecord, row.master === null ? null : JSON.parse(row.master) as MasterRecord);
  }
}
