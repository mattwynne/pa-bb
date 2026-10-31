// PRODUCT intake, intentionally separate from synthetic auditEvidence controls.
// S01 has no implemented semantic driver or registered semantic schema. Thus no
// JSON registry/attachment can confer execution credit or expose a future tool.
// This is a closed code boundary, not a configurable list of trusted strings.
// A future slice must replace this refusal with a real adapter which obtains the
// production registration/schema, captures the invocation at the application /
// HTTP boundary, and compares independent before/request/readback/effects. An
// attachment, boolean, capability label or fixture digest is not that adapter.
import assert from 'node:assert/strict';
import { fixtureFile } from './audit.mjs';
export function assertProductIntake({ manifest, registry, results, fixtures, root }) {
  for (const result of results) {
    const fixture = fixtures[result.fixtureId]; assert.ok(fixture, 'product fixture missing');
    const data = fixtureFile(root, fixture);
    assert.ok(!data.auditControlOnly, 'synthetic auditControlOnly fixture forbidden on product intake');
  }
  assert.equal(results.length, 0, 'missing implemented semantic driver and production registered schema');
  assert.deepEqual(Object.keys(registry.operations), [], 'registry has no implemented semantic driver / production registered schema');
  assert.deepEqual(registry.exposed, [], 'no implemented semantic variant may be exposed');
  assert.deepEqual(manifest.expansion.variantExposure, {}, 'no implemented semantic exposure adapter');
  for (const state of Object.values(manifest.expansion.deliveryOverrides))
    assert.equal(state.status, 'planned', 'semantic delivery lacks implemented invocation/readback adapter');
}
