import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCanonicalWorkspace } from './development.ts';
import { originUrl } from '../core/workspace.ts';
import type { Workspace, SourceSync } from '../core/workspace.ts';
const exec = promisify(execFile);

/** The only source-checkout write: an explicitly requested, normal Git fast
 * forward. No reset, stash, merge commit, branch switch, hook or push. */
export async function syncWorkspace(checkout: string, expected: Workspace, signal: AbortSignal, source = originUrl): Promise<SourceSync> {
  if (!expected.behind) return { state: 'held', reason: 'changed' };
  if (expected.dirty || expected.ahead) return { state: 'held', reason: 'local_work' };
  const before = await inspectCanonicalWorkspace(signal, source, checkout, 'HEAD');
  if (!before || before.head !== expected.head) return { state: 'held', reason: 'changed' };
  if (before.dirty) return { state: 'held', reason: 'local_work' };
  const home = await mkdtemp(join(tmpdir(), 'pa-source-update-'));
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = async (args: string[]) => {
      await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', 'credential.helper=', '-c', 'gc.auto=0', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        ...(source === originUrl ? [] : ['-c', 'protocol.file.allow=always']), '-c', 'http.followRedirects=false', ...args],
      { cwd: checkout, env, signal, timeout: 60_000, maxBuffer: 1024 * 1024 });
    };
    // Negotiate only the already-public reviewed HEAD, not private local refs.
    await git(['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-gc', `--negotiation-tip=${expected.head}`, source, expected.originHead]);
    await git(['merge', '--ff-only', '--no-overwrite-ignore', expected.originHead]);
    const after = await inspectCanonicalWorkspace(signal, source, checkout, expected.originHead);
    if (!after || after.head !== expected.originHead || after.dirty) throw new Error('source_changed');
    return { state: 'updated', workspace: after };
  } finally { await rm(home, { recursive: true, force: true }); }
}
