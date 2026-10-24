// Historical Calendar publisher schema only. The updater does not consume a release feed.
import { z } from 'zod';
import semver from 'semver';
export const MAX_RECORD = 256 * 1024;
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const identitySchema = z.string().regex(/^pa-release-[0-9a-f]{40}$/);
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
