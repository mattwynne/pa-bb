import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { reference } from '../contract.ts';

type Thread = { threadId: string; archived: boolean; id: string; kind: 'project' | 'area' };

export async function readThreadReferences(sdk: BbPluginApi['sdk'], source: string, signal: AbortSignal, includeAreas = true) {
  const refs: Thread[] = [], warnings = new Set<string>(), seen = new Set<string>();
  for (const archived of [false,true]) {
    for (let offset = 0; ; ) {
      signal.throwIfAborted();
      if (offset >= 20000) { warnings.add('thread_scan_limit'); break; }
      const page = await sdk.threads.list({ archived, includeHidden: true, offset, limit: 100, signal });
      if (!page.length) break;
      const ids = page.map(t => t.id);
      if (ids.some(id => seen.has(id))) { warnings.add('thread_listing_changed'); break; }
      for (const id of ids) seen.add(id);
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
  return { refs, warnings: [...warnings] };
}
