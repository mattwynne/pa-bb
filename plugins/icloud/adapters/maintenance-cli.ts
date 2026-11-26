import { cliCommand, defineCli, PluginCliError } from '@get-bb/plugin-sdk';
import { maintenanceRunId } from '../core/maintenance.ts';
import { category } from '../core/ports.ts';
import { listingCheckers } from './rclone-process.ts';
import type { ListingCheckers, RcloneProcess } from './rclone-process.ts';

export function maintenanceCli(
  status: () => object,
  mutate: (action: 'pause' | 'restore', runId: string, signal?: AbortSignal) => Promise<unknown>,
  benchmark: (id: string, checkers: ListingCheckers, signal?: AbortSignal) => ReturnType<RcloneProcess['benchmarkListing']>,
  binding: (id: string, runId: string, binary: string, sha256: string, signal?: AbortSignal) => Promise<{mirrorId:string; binding:string}>,
) {
  const render = () => ({ exitCode: 0, stdout: JSON.stringify(status()) });
  const json = { type: 'boolean', description: 'Emit machine-readable errors as JSON' } as const;
  const operation = (action: 'pause' | 'restore', summary: string) => cliCommand({
    summary,
    options: {
      'run-id': { type: 'string', required: true, description: 'Maintenance run UUID. Keep it for status read-back and restore.' },
      json,
    },
    async run({ options }, { signal }) {
      const id = maintenanceRunId.safeParse(options['run-id']);
      if (!id.success) throw new PluginCliError('Supply a valid maintenance run UUID.', { code: 'invalid_selection' });
      try { await mutate(action, id.data.toLowerCase(), signal); }
      catch (error) {
        const busy = category(error) === 'busy';
        throw new PluginCliError(busy ? 'iCloud refused the action while work or another hold is active, or the run does not match.' : 'iCloud could not confirm the maintenance change.', {
          code: busy ? 'busy' : 'unavailable',
          hint: 'Run bb icloud maintenance status --json and inspect the run before taking further action.',
        });
      }
      return render();
    },
  });
  return defineCli({
    name: 'icloud',
    summary: 'Inspect iCloud maintenance and benchmark directory listing through BB.',
    commands: {
      'maintenance status': cliCommand({ summary: 'Read iCloud admission, drain and maintenance receipt status.', options: { json }, run: render }),
      'maintenance pause': operation('pause', 'Hold iCloud scheduling and note admission for one maintenance run.'),
      'maintenance restore': operation('restore', 'Restore eligible prior scheduling after the matching hold has drained.'),
      'delivery binding': cliCommand({
        summary: 'Read the provider binding for one initialized Obsidian mirror during a drained maintenance window.',
        options: {
          'mirror-id': { type: 'string', required: true, description: 'Exact initialized mirror ID from iCloud inventory.' },
          'run-id': { type: 'string', required: true, description: 'Current drained maintenance run UUID.' },
          binary: { type: 'string', required: true, description: 'Absolute path to the pinned iCloud note worker.' },
          sha256: { type: 'string', required: true, description: 'SHA-256 of the executable.' },
          json,
        },
        async run({ options }, { signal }) {
          const id = options['mirror-id'];
          const runId = maintenanceRunId.safeParse(options['run-id']);
          if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || !runId.success)
            throw new PluginCliError('Supply an exact mirror ID and a valid maintenance run UUID.', {code:'invalid_selection'});
          try {
            const result = await binding(id,runId.data.toLowerCase(),options.binary,options.sha256,signal);
            return { exitCode:0,stdout:JSON.stringify(result) };
          } catch (error) {
            throw new PluginCliError('iCloud could not verify the selected mirror binding during this maintenance run.', {code:category(error)});
          }
        },
      }),
      'benchmark listing': cliCommand({
        summary: 'Time one read-only recursive listing on an initialized mirror. Returns aggregate JSON.',
        options: {
          'mirror-id': { type: 'string', required: true, description: 'Exact initialized mirror ID from iCloud inventory.' },
          checkers: { type: 'enum', values: listingCheckers, required: true, description: 'Number of concurrent directory workers.' },
          json,
        },
        async run({ options }, { signal }) {
          if (!/^[a-zA-Z0-9-]{1,64}$/.test(options['mirror-id'])) throw new PluginCliError('Supply an exact iCloud mirror ID.', { code: 'invalid_selection' });
          try {
            const result = await benchmark(options['mirror-id'], options.checkers, signal);
            return { exitCode: result.outcome === 'succeeded' ? 0 : 1, stdout: JSON.stringify(result) };
          } catch (error) {
            const failure = category(error);
            throw new PluginCliError(failure === 'busy' ? 'iCloud is busy. Retry when the sync owner is idle.' : 'iCloud could not admit the listing. Check the initialized mirror and connection status.', { code: failure });
          }
        },
      }),
    },
  });
}
