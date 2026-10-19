#!/usr/bin/env node
// Run with Node >=22.18 after npm ci in plugins/pa-updates.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseRelease, commitSchema } from '../plugins/pa-updates/core/release.ts';
const repo = fileURLToPath(new URL('../', import.meta.url));
export function buildRecord(pkg, commit, notes) {
  commitSchema.parse(commit);
  if (pkg.name !== 'bb-plugin-google-calendar') throw new Error('Wrong pilot package');
  return parseRelease(JSON.stringify({ schemaVersion: 1, identity: `pa-release-${commit}`, sourceCommit: commit,
    plugins: [{ id: 'google-calendar', version: pkg.version, subdirectory: 'plugins/google-calendar', sourceCommit: commit,
      engines: { bb: pkg.engines?.bb, bbPluginSdk: pkg.engines?.bbPluginSdk }, notes }] }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [commit, output] = process.argv.slice(2);
  commitSchema.parse(commit);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 }).trim();
  if (git('rev-parse', 'HEAD') !== commit) throw new Error('Generator must run at the tested revision');
  const pkg = JSON.parse(git('show', `${commit}:plugins/google-calendar/package.json`));
  const record = buildRecord(pkg, commit, process.env.PA_RELEASE_NOTES ?? 'Google Calendar baseline. Release discovery is read-only; no plugin code is installed by checking.');
  await writeFile(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(record.identity);
}
