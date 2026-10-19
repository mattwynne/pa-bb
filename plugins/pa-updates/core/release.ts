import { z } from 'zod';
import semver from 'semver';
export const REPOSITORY = 'mattwynne/pa-bb';
export const SOURCE_URL = `https://github.com/${REPOSITORY}.git`;
export const MAX_RECORD = 256 * 1024;
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const identitySchema = z.string().regex(/^pa-release-[0-9a-f]{40}$/);
// Scope is trusted code, never a remote record or RPC argument.
export const PILOT_PATHS = ['plugins/google-calendar', 'shared/connection-ui', 'scripts/sync-connection-ui.mjs'];
const range = z.string().min(1).max(128).refine(value => semver.validRange(value) !== null);
export const releaseSchema = z.strictObject({
  schemaVersion: z.literal(1), identity: identitySchema, sourceCommit: commitSchema,
  plugins: z.array(z.strictObject({
    id: z.literal('google-calendar'), version: z.string().max(64).refine(value => semver.valid(value) !== null),
    subdirectory: z.literal('plugins/google-calendar'), sourceCommit: commitSchema,
    engines: z.strictObject({ bb: range, bbPluginSdk: range }),
    notes: z.string().max(8000).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/),
  })).length(1),
}).refine(record => record.identity === `pa-release-${record.sourceCommit}` && record.plugins.every(plugin => plugin.sourceCommit === record.sourceCommit));
export type Release = z.infer<typeof releaseSchema>;
export function parseRelease(text: string, identity?: string): Release {
  if (Buffer.byteLength(text) > MAX_RECORD) throw new Error('invalid_release');
  const record = releaseSchema.parse(JSON.parse(text));
  if (identity !== undefined && record.identity !== identity) throw new Error('invalid_release');
  return record;
}
export type Installed = { version: string; revision: string | null; source: 'trusted' | 'other' | 'unavailable' };
export type Comparison = 'no_plugin' | 'inventory_unavailable' | 'no_release' | 'current' | 'available' | 'installed_newer' | 'source_mismatch' | 'revision_unavailable' | 'incompatible' | 'compatibility_unavailable';
export function compare(installed: Installed | null | undefined, release: Release | null, runtime: { bb: string; sdk: string } | null): Comparison {
  if (installed === undefined) return 'inventory_unavailable';
  if (installed === null) return 'no_plugin';
  if (!release) return 'no_release';
  if (!runtime) return 'compatibility_unavailable';
  const target = release.plugins[0];
  if (!semver.satisfies(runtime.bb, target.engines.bb) || !semver.satisfies(runtime.sdk, target.engines.bbPluginSdk)) return 'incompatible';
  if (!semver.valid(installed.version)) return 'inventory_unavailable';
  if (semver.gt(installed.version, target.version)) return 'installed_newer';
  if (installed.source === 'other') return 'source_mismatch';
  if (!installed.revision || installed.source === 'unavailable') return 'revision_unavailable';
  if (installed.version === target.version) {
    if (!target.sourceCommit.startsWith(installed.revision)) return 'source_mismatch';
    return installed.revision.length === 40 ? 'current' : 'revision_unavailable';
  }
  return 'available';
}
