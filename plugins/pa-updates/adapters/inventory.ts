import semver from 'semver';
import { CheckError } from '../core/model.ts';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { Inventory, Ports } from '../core/model.ts';
import { SOURCE_URL } from '../core/release.ts';
export function installedInventory(bb: BbPluginApi, diagnose: Ports['diagnose'] = () => {}) {
  return async (signal: AbortSignal): Promise<Inventory> => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const listed = await bb.sdk.plugins.list({ signal: bounded });
    const plugin = listed.plugins.find(plugin => plugin.id === 'google-calendar');
    const version = await bb.sdk.system.version({ signal: bounded }).catch(() => { diagnose('inventory', 'unavailable'); return null; });
    // SDK 0.6.15 is our verified API baseline, not a claim about arbitrary future BB.
    const runtime = version && version.currentVersion.length <= 64 && semver.valid(version.currentVersion) ? { bb: version.currentVersion, sdk: '0.6.15' } : null;
    if (!plugin) return { installed: null, runtime };
    if (plugin.version.length > 64 || !semver.valid(plugin.version)) throw new CheckError('unavailable');
    const source = await bb.sdk.plugins.getSource({ pluginId: 'google-calendar', signal: bounded }).catch(() => { diagnose('inventory', 'unavailable'); return null; });
    if (!source) return { installed: { version: plugin.version, revision: null, source: 'unavailable' }, runtime };
    const trusted = source.requested.startsWith(`git:${SOURCE_URL}@`) && source.subdirectory === 'plugins/google-calendar';
    // BB 0.45.0 history includes validated candidates, NOT just activations.
    // Use only the installed-source display and preserve its reported precision.
    // Never expand its short SHA from history or infer a match from version.
    const prefix = `${SOURCE_URL}@`;
    const revision = trusted && source.resolved.startsWith(prefix)
      ? source.resolved.slice(prefix.length).match(/^[^\s]+ \(([0-9a-f]{12}|[0-9a-f]{40})\)$/)?.[1] ?? null : null;
    return { installed: { version: plugin.version, revision, source: trusted ? 'trusted' : 'other' }, runtime };
  };
}
