import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { StateRepository, State } from '../core/ports.ts';
import type { RunHistoryRepository } from '../core/diagnostics.ts';
export function bbState(bb: BbPluginApi): StateRepository {
  return { load: () => bb.storage.kv.get<State>('sync-state'), save: state => bb.storage.kv.set('sync-state', state) };
}
export function bbRunHistory(bb: BbPluginApi): RunHistoryRepository {
  return { load: () => bb.storage.kv.get<unknown>('sync-diagnostics'), save: value => bb.storage.kv.set('sync-diagnostics', value) };
}
