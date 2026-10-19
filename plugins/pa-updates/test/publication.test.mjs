import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { parse } from 'yaml';
import { buildRecord } from '../../../scripts/build-pa-release.mjs';
import { parseRelease } from '../core/release.ts';
const commit = 'a'.repeat(40);
test('generator derives pilot metadata, schema validates, semantic cross-fields fail closed', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../google-calendar/package.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(await readFile(new URL('../../../releases/pa-release-v1.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema);
  const record = buildRecord(pkg, commit, 'Baseline');
  assert.equal(record.plugins[0].version, pkg.version); assert.deepEqual(record.plugins[0].engines, { bb: pkg.engines.bb, bbPluginSdk: pkg.engines.bbPluginSdk });
  assert.ok(validate(record), JSON.stringify(validate.errors)); assert.deepEqual(parseRelease(JSON.stringify(record)), record);
  for (const mutate of [r => { r.schemaVersion = 2; }, r => { r.plugins.push(r.plugins[0]); }, r => { r.plugins[0].subdirectory = '/private'; }, r => { r.sourceCommit = 'main'; }, r => { r.plugins[0].notes = '\0'; }, r => { r.url = 'https://evil.invalid'; }]) {
    const invalid = structuredClone(record); mutate(invalid); assert.equal(validate(invalid), false); assert.throws(() => parseRelease(JSON.stringify(invalid)));
  }
  assert.throws(() => buildRecord({ ...pkg, name: 'wrong' }, commit, 'Baseline'));
});
test('workflow limits release authority to trusted main publishing after exact-revision lockfile checks', async () => {
  const workflow = parse(await readFile(new URL('../../../.github/workflows/pa-release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']); assert.equal(workflow.permissions.contents, 'read');
  const { verify, publish } = workflow.jobs;
  assert.match(verify.if, /refs\/heads\/main/); assert.equal(verify.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(publish.needs, 'verify'); assert.equal(publish.permissions.contents, 'write'); assert.match(publish.if, /refs\/heads\/main/);
  const runs = verify.steps.map(step => step.run ?? '').join('\n');
  for (const expected of ['npm ci --prefix plugins/google-calendar', 'npm test --prefix plugins/google-calendar', 'npm run typecheck --prefix plugins/google-calendar', 'npm ci --prefix plugins/pa-updates', 'npm test --prefix plugins/pa-updates', 'sync-connection-ui.mjs --check', 'build-pa-release.mjs "$GITHUB_SHA"']) assert.ok(runs.includes(expected));
  const publication = publish.steps.map(step => step.run ?? '').join('\n'); assert.match(publication, /matching-refs/); assert.match(publication, /test "\$count" = 0/); assert.ok(!publication.includes('--clobber')); assert.ok(!publication.includes('npm '));
});
