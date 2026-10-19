import type { Release } from '../core/release.ts';
import type { Ports, Saved, Local } from '../core/model.ts';
export const SHA = 'a'.repeat(40);
export const record = (version = '0.1.1', commit = SHA): Release => ({ schemaVersion: 1, identity: `pa-release-${commit}`, sourceCommit: commit, plugins: [{ id: 'google-calendar', version, subdirectory: 'plugins/google-calendar', sourceCommit: commit, engines: { bb: '>=0.45.0', bbPluginSdk: '>=0.6.15 <1' }, notes: 'Tested Calendar baseline. <script>inert text</script>' }] });
export const clean = (): Local => ({ outcome: 'clean', reason: 'observed', at: '2026-10-19T12:00:00.000Z' });
export function harness() {
  let time = Date.parse('2026-10-19T12:00:00Z'); let stored: Saved | undefined;
  const logs: string[] = []; let calls = 0;
  const ports: Ports = {
    async feed() { calls++; return { text: JSON.stringify(record()), identity: record().identity }; },
    async inventory() { return { installed: { version: '0.1.1', revision: SHA, source: 'trusted' }, runtime: { bb: '0.45.0', sdk: '0.6.15' } }; },
    async local() { return clean(); }, async load() { return stored; }, async save(state) { stored = structuredClone(state); },
    now: () => time, diagnose: (stage, category) => { logs.push(`${stage}:${category}`); },
  };
  return { ports, logs, advance: (ms = 60_001) => { time += ms; }, calls: () => calls, stored: () => stored };
}
