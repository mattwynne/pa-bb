import { execFile } from 'node:child_process';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PILOT_PATHS, commitSchema } from '../core/release.ts';
import type { Local } from '../core/model.ts';
const LIMIT = 1024 * 1024;
class GitFailure extends Error { reason: Local['reason']; constructor(reason: Local['reason']) { super(reason); this.reason = reason; } }
export function localGit(checkout: string | undefined, now: () => number = Date.now) {
  return async (target: string | null, signal: AbortSignal): Promise<Local> => {
    const result = (outcome: Local['outcome'], reason: Local['reason']): Local => ({ outcome, reason, at: new Date(now()).toISOString() });
    if (!checkout) return result('not_assessed', 'mapping_missing');
    if (!isAbsolute(checkout)) return result('not_assessed', 'unsupported');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      const root = await realpath(checkout);
      if (!(await lstat(join(root, '.git'))).isDirectory()) throw new GitFailure('unsupported');
      // No hooks, external diff/text converters, optional index writes, pagers,
      // repository includes or caller Git environment. Never fetch in a checkout.
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
      const git = async (args: string[], allowOne = false) => {
        try {
          return await new Promise<Buffer>((resolve, reject) => {
            let failure: Error | null = null; let output = Buffer.alloc(0);
            const child = execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', ...args],
              { cwd: root, env, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: LIMIT, encoding: 'buffer' },
              (error, stdout) => { failure = error; output = stdout; });
            // Node's execFile AbortSignal path can send SIGTERM regardless of
            // killSignal. Explicitly kill and join close, including children
            // that ignore TERM, before disposal can complete.
            const terminate = () => { child.kill('SIGKILL'); };
            bounded.addEventListener('abort', terminate, { once: true });
            if (bounded.aborted) terminate();
            child.once('close', () => { bounded.removeEventListener('abort', terminate); if (failure) reject(failure); else resolve(output); });
          });
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: Buffer };
          if (allowOne && failure.code === 1) return null;
          throw new GitFailure(bounded.aborted ? (signal.aborted ? 'cancelled' : 'limit') : failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'limit' : 'unavailable');
        }
      };
      const config = (await git(['config', '--local', '--no-includes', '--list', '-z']))!.toString();
      if (config.split('\0').some(entry => /^(filter\.|include\.|includeif\.|extensions\.)/i.test(entry))) throw new GitFailure('unsupported');
      // Linked worktrees, shallow repos, replace refs and submodules need a future
      // layout/history policy. Unknown is safer than an incomplete clean verdict.
      const top = (await git(['rev-parse', '--show-toplevel']))!.toString().trim();
      if (await realpath(top) !== root || (await git(['rev-parse', '--is-shallow-repository']))!.toString().trim() !== 'false') throw new GitFailure('unsupported');
      if ((await git(['for-each-ref', '--format=%(refname)', 'refs/replace']))!.length) throw new GitFailure('unsupported');
      try { if ((await lstat(join(root, '.git/info/grafts'))).size) throw new GitFailure('unsupported'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const stages = (await git(['ls-files', '--stage', '-z', '--', ...PILOT_PATHS]))!.toString();
      if (stages.split('\0').some(line => line.startsWith('160000 '))) throw new GitFailure('unsupported');
      const snapshot = async () => {
        const head = (await git(['rev-parse', '--verify', 'HEAD']))!.toString().trim();
        if (!commitSchema.safeParse(head).success) throw new GitFailure('unsupported');
        const status = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', ...PILOT_PATHS]))!;
        const hash = createHash('sha256').update(head).update(status);
        // Hash both diff layers: HEAD alone misses concurrent staging/unstaging.
        for (const args of [['diff', '--no-ext-diff', '--no-textconv', '--binary'], ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary']]) hash.update((await git([...args, '--', ...PILOT_PATHS]))!);
        const index = await open(join(root, '.git/index'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await index.stat();
          if (!stat.isFile()) throw new GitFailure('unsupported');
          if (stat.size > 4 * LIMIT) throw new GitFailure('limit');
          const bytes = Buffer.alloc(4 * LIMIT + 1); let size = 0;
          while (size < bytes.length) { const read = await index.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
          if (size > 4 * LIMIT) throw new GitFailure('limit');
          hash.update(bytes.subarray(0, size));
        } finally { await index.close(); }
        return { head, dirty: status.length > 0, digest: hash.digest('hex') };
      };
      const before = await snapshot();
      let verdict: Local;
      if (before.dirty) verdict = result('local_changes', 'observed');
      else if (!target) verdict = result('not_assessed', 'no_candidate');
      else {
        if (!commitSchema.safeParse(target).success) throw new GitFailure('target_missing');
        try { await git(['cat-file', '-e', `${target}^{commit}`]); } catch { throw new GitFailure('target_missing'); }
        if (await git(['merge-base', '--is-ancestor', before.head, target], true)) verdict = result('clean', 'observed');
        else if (await git(['merge-base', '--is-ancestor', target, before.head], true)) {
          const commits = (await git(['rev-list', '--full-history', '--max-count=1001', `${target}..${before.head}`, '--', ...PILOT_PATHS]))!.toString().trim().split('\n').filter(Boolean);
          verdict = commits.length ? result('local_commits', 'observed') : result('clean', 'observed');
        } else verdict = result('cannot_establish', 'diverged');
      }
      const after = await snapshot();
      if (before.digest !== after.digest) return result('cannot_establish', 'changed');
      return { ...verdict, at: new Date(now()).toISOString() };
    } catch (error) { return result('not_assessed', error instanceof GitFailure ? error.reason : signal.aborted ? 'cancelled' : 'unavailable'); }
  };
}
