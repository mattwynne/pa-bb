// Disposable installed-BB entry, copied over server.ts in a generated package.
// Never included in the production package/build. Generated local alias only.
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { plugin } from './production.ts';
import { bbState } from './adapters/bb-state.ts';
import { RcloneProcess } from './adapters/rclone-process.ts';
import { syncArguments } from './adapters/rclone-cloud-provider.ts';
import { NoteRuntime } from './adapters/note-runtime.ts';
import { NoteStore } from './adapters/note-store.ts';
import type { State } from './core/ports.ts';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

export default async function fixture(bb: BbPluginApi) {
  const database = bb.storage.database();
  if (!isAbsolute(database.name)) throw new Error('fixture database must be absolute');
  const root = join(dirname(database.name), 'sync');
  const alias = process.env.BB_GENERATED_ALIAS_ROOT;
  if (!alias || !isAbsolute(alias) || !alias.startsWith('/tmp/')) throw new Error('fixture requires a generated /tmp alias root');
  const existing = bbState(bb);
  let currentState = await existing.load();
  if (!currentState) {
    // Only an empty fresh fixture is initialized; never reset an existing
    // baseline or recover a failed/blocked source by recreating it.
    const preparer = new RcloneProcess(root, '/usr/local/bin/rclone');
    try {
      await preparer.ensure();
      await preparer.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: alias }, opt: { nonInteractive: true } });
      for (const [id, folder] of [['one', 'generated'], ['two', 'other']] as const) {
        const mirror = join(root, 'mirrors', id), baseline = join(root, 'baselines', id);
        await mkdir(mirror); await mkdir(baseline);
        await preparer.run(syncArguments(`icloud:${folder}`, mirror, baseline, true));
        await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
      }
      currentState = { connected: true, challenge: null, mirrors: (['one', 'two'] as const).map((id, index) => ({ id, folder: { id: Buffer.from(index ? 'other' : 'generated').toString('base64url'), name: index ? 'Other' : 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready' as const, lastSuccess: new Date().toISOString(), failure: null, blocker: null })) };
      await existing.save(currentState);
    } finally { await preparer.stop(); } // Release actual flock before production entry.
  }
  const repository = { async load() { currentState = await existing.load(); return currentState; }, async save(state: State) { await existing.save(state); currentState = state; } };
  const worker = new RcloneProcess(root, '/usr/local/bin/rclone', '512k');
  const runtime = new NoteRuntime(root, database, worker, new NoteStore(join(root, 'note-operations')), () => {
    if (!currentState) throw new Error('fixture state not loaded');
    return currentState;
  });
  await plugin(bb, { worker, runtime, repository });
}
