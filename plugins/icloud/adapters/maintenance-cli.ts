import { cliCommand, defineCli, PluginCliError } from '@get-bb/plugin-sdk';
import { maintenanceRunId } from '../core/maintenance.ts';
import { category } from '../core/ports.ts';

export function maintenanceCli(
  status: () => object,
  mutate: (action: 'pause' | 'restore', runId: string, signal?: AbortSignal) => Promise<unknown>,
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
    summary: 'Inspect or control iCloud maintenance through BB.',
    commands: {
      'maintenance status': cliCommand({ summary: 'Read iCloud admission, drain and maintenance receipt status.', options: { json }, run: render }),
      'maintenance pause': operation('pause', 'Hold iCloud scheduling and file admission for one maintenance run.'),
      'maintenance restore': operation('restore', 'Restore eligible prior scheduling after the matching hold has drained.'),
    },
  });
}
