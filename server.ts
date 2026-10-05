import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { reconcilePiRegistration } from './src/pi-registration.mjs';

/** The source entry lives at the package root; a BB build emits dist/server.js. */
async function packagedExtension(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, 'spike/pi-extension'), join(here, '../spike/pi-extension')]) {
    try { await access(join(path, 'package.json')); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('PA BB packaged Pi extension is missing');
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    piAgentDir: {
      type: 'string',
      label: 'Pi agent directory (opt in)',
      description: 'Absolute path to the Pi agent directory for the BB Pi process (e.g. /home/matt/.pi/agent). Leave blank to avoid modifying Pi.',
      default: '',
    },
  });
  const { piAgentDir } = await settings.get();
  const agentDir = piAgentDir.trim();
  if (!agentDir) {
    bb.log.info('PA BB Pi registration disabled (no Pi agent directory configured)');
    return;
  }
  if (!isAbsolute(agentDir)) throw new Error('PA BB Pi agent directory must be an absolute path');
  const result = await reconcilePiRegistration({ agentDir, packageDir: await packagedExtension() });
  bb.log.info(`PA BB Pi registration ${result.status}; new Pi sessions will see the extension`);
  // onDispose also fires on ordinary reload/shutdown. Never remove a persistent
  // Pi registration there; disable/uninstall cleanup requires a separate command.
}
