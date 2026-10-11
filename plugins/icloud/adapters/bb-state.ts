import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { StateRepository, State } from '../core/ports.ts';
export function bbState(bb: BbPluginApi): StateRepository {
  return { load: () => bb.storage.kv.get<State>('sync-state'), save: state => bb.storage.kv.set('sync-state', state) };
}
