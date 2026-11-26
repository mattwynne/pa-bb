import { cliCommand, defineCli, PluginCliError } from '@get-bb/plugin-sdk';
import { maintenanceRunId } from '../core/maintenance.ts';
import { category } from '../core/ports.ts';
import { listingCheckers } from './rclone-process.ts';
import type { ListingCheckers, RcloneProcess } from './rclone-process.ts';

export function maintenanceCli(
  status: () => object,
  mutate: (action: 'pause' | 'restore', runId: string, signal?: AbortSignal) => Promise<unknown>,
  benchmark: (id: string, checkers: ListingCheckers, signal?: AbortSignal) => ReturnType<RcloneProcess['benchmarkListing']>,
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
