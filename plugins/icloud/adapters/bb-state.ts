import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { StateRepository, State } from '../core/ports.ts';
import type { RunHistoryRepository } from '../core/diagnostics.ts';
import { SqliteRunHistory, HISTORY_MIGRATIONS } from './run-history.ts';
export function bbState(bb: BbPluginApi): StateRepository {
  return { load: () => bb.storage.kv.get<State>('sync-state'), save: state => bb.storage.kv.set('sync-state', state) };
}
export function bbRunHistory(bb: BbPluginApi): RunHistoryRepository {
  return new SqliteRunHistory(() => bb.storage.database(), db => bb.storage.migrate(db, [...HISTORY_MIGRATIONS]), () => bb.storage.kv.get<unknown>('sync-diagnostics'));
}
