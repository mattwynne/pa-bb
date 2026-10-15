// Generated-package entry only: real v1 implementation, generated alias and IDs.
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { plugin } from './production.ts';
import { bbState } from './adapters/bb-state.ts';
import { RcloneProcess } from './adapters/rclone-process.ts';
import { RcloneCloudProvider, syncArguments } from './adapters/rclone-cloud-provider.ts';
import { NoteStore } from './adapters/note-store.ts';
import type { State } from './core/ports.ts';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
export default async function fixture(bb: BbPluginApi) {
  const database = bb.storage.database();
  if (!isAbsolute(database.name)) throw new Error('fixture database must be absolute');
  const root = join(dirname(database.name), 'sync');
  const alias = process.env.BB_GENERATED_ALIAS_ROOT;
  if (!alias || !isAbsolute(alias) || !alias.startsWith('/tmp/')) throw new Error('fixture requires generated alias');
  const events = process.env.BB_FIXTURE_EVENTS;
  if (!events || !events.startsWith('/tmp/')) throw new Error('fixture requires private events');
  await appendFile(events, JSON.stringify({ event: 'legacy-icloud-factory', at: performance.now() }) + '\n');
  const existing = bbState(bb);
  let state = await existing.load();
  if (!state) {
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
      state = { connected: true, challenge: null, mirrors: (['one', 'two'] as const).map((id, index) => ({ id, folder: { id: Buffer.from(index ? 'other' : 'generated').toString('base64url'), name: index ? 'Other' : 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready' as const, lastSuccess: new Date().toISOString(), failure: null, blocker: null })) };
      await existing.save(state);
    } finally { await preparer.stop(); }
  }
  const worker = new RcloneProcess(root, '/usr/local/bin/rclone');
  const repository = { load: () => existing.load(), save: (next: State) => existing.save(next) };
  const notes = new NoteStore(join(root, 'note-operations'));
  const provider = new RcloneCloudProvider(root, (method, body) => worker.call(method, body), (args, capture, report) => worker.run(args, capture, report), () => worker.checkAvailability(), () => worker.stop(), operation => worker.withFiles(operation), mirror => notes.reconcile(mirror.id, provider.localFolder(mirror)));
  await plugin(bb, { provider, notes, repository });
}
