import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { expand, exposureClosure } from './expand.mjs';
import { validateRequest, validatePlannedMappings } from './wire.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function fixtureFile(root, fixture) {
  assert.ok(fixture?.path && fixture.sha256 && fixture.provenance?.source && fixture.provenance?.authorship, 'fixture provenance missing');
  const path = realpathSync(resolve(root, fixture.path)), base = realpathSync(root);
  assert.ok(path.startsWith(base + sep), 'fixture escaped root');
  const bytes = readFileSync(path); assert.equal(digest(bytes), fixture.sha256, 'fixture digest mismatch');
  const data = JSON.parse(bytes); assert.ok(data.provenance?.source && data.provenance.authorship, 'fixture source provenance missing');
  // Expectations must be inert data, not imports/evaluated planners.
  return data;
}
export function checkDuplicateNames(record, vector) {
  if (record.ledgerId !== 'C101' || record.requestedMode !== 'direct' || record.outcomeVariant !== 'success') return;
  if (!['createDuplicateName','exactIdAmongDuplicates','explicitAllDuplicates'].includes(record.base)) return;
  const before = vector.before?.ranges, after = vector.after?.ranges;
  assert.ok(Array.isArray(before) && Array.isArray(after), 'duplicate-name facts require independent ranges');
  const b = before.filter(r => r.name === 'Shared'), a = after.filter(r => r.name === 'Shared');
  assert.equal(vector.before.text, vector.after.text, 'duplicate-name facts: text preservation');
  if (record.base === 'createDuplicateName') {
    assert.equal(b.length, 1, 'duplicate-name facts: before'); assert.equal(a.length, 2, 'duplicate-name facts: after');
    assert.equal(new Set(a.map(r => r.id)).size, 2, 'duplicate-name facts: distinct IDs');
    assert.deepEqual(a.find(r => r.id === b[0].id), b[0], 'duplicate-name facts: original preserved');
    assert.equal(vector.request.createNamedRange?.name, 'Shared', 'duplicate-name facts: request');
  } else {
    assert.equal(b.length, 2, 'duplicate-name facts: before duplicates');
    const ids = vector.requests?.map(r => r.deleteNamedRange?.namedRangeId);
    if (record.base === 'explicitAllDuplicates') { assert.deepEqual(ids?.sort(), b.map(r => r.id).sort(), 'duplicate-name facts: exact deletion'); assert.equal(a.length, 0); }
    else { assert.equal(ids?.length, 1); assert.equal(a.length, 1); assert.deepEqual(a[0], b.find(r => r.id !== ids[0])); }
  }
}
export function assertExternalGates(gates) {
  for (const [id, gate] of Object.entries(gates)) if (gate.status !== 'planned') {
    assert.ok(gate.evidence?.kind === 'external' && gate.evidence.attributedTo && gate.evidence.reference, `external evidence required: ${id}`);
    for (const fact of gate.requiredEvidence) assert.ok(gate.evidence.facts?.[fact], `external evidence missing: ${id}/${fact}`);
  }
}
// Called with parsed, current Cucumber execution evidence, not manifest passed flags.
export function auditEvidence({ manifest, registry, cases, results, fixtures, root, runId }) {
  const records = expand(manifest), byKey = new Map(records.map(r => [r.key, r]));
  validatePlannedMappings(manifest); assertExternalGates(manifest.externalGates);
  const byVariant = new Map();
  for (const r of records) { const key = `${r.operation}/${r.semanticVariant}`; if (!byVariant.has(key)) byVariant.set(key, []); byVariant.get(key).push(r); }
  for (const [operation, registration] of Object.entries(registry.operations ?? {})) {
    assert.ok(registration.variants && Object.keys(registration.variants).length, 'empty operation registration');
    for (const [variant, binding] of Object.entries(registration.variants)) {
      const matches = byVariant.get(`${operation}/${variant}`) ?? [];
      assert.ok(matches.length, 'unregistered variant in operation registry');
      for (const r of matches) {
        assert.equal(binding.driver, r.driver, 'registry driver'); assert.equal(binding.schema, r.schema, 'registry schema');
        assert.equal(binding.requestedMode, r.requestedMode, 'registry requested mode');
        assert.ok(binding.capability && JSON.stringify(binding.requests) === JSON.stringify(r.requests), 'registry capability/request binding');
      }
    }
  }
  const seen = new Set();
  for (const c of cases) { assert.ok(!seen.has(c.caseId), `duplicate caseId: ${c.caseId}`); seen.add(c.caseId); assert.ok(byKey.has(c.key), `phantom scenario: ${c.key}`); }
  const byCase = new Map(cases.map(c => [c.key, c]));
  for (const c of cases) {
    const r = byKey.get(c.key);
    assert.equal(c.caseId, r.caseId, 'caseId binding');
    assert.equal(c.requestedMode, r.requestedMode, 'requested mode mismatch');
    assert.equal(c.driver, r.driver, 'driver mismatch');
    assert.equal(c.schema, r.schema, 'schema binding mismatch');
    assert.equal(c.kind, r.kind, 'guard cannot become product success');
    if (r.disposition === 'N') assert.ok(!['refused','routed'].includes(c.observedOutcome), 'refusal cannot close N');
    assert.equal(c.observedOutcome, r.outcomeVariant, 'outcome binding mismatch');
    const registration = registry.operations?.[r.operation];
    assert.ok(registration?.variants?.[r.semanticVariant], 'unregistered variant');
    const v = registration.variants[r.semanticVariant];
    assert.equal(v.driver, r.driver, 'registry driver'); assert.equal(v.schema, r.schema, 'registry schema');
    assert.equal(v.requestedMode, r.requestedMode, 'registry requested mode');
    assert.ok(v.capability && JSON.stringify(v.requests) === JSON.stringify(r.requests), 'capability/request binding');
  }
  for (const [key, state] of Object.entries(manifest.expansion.deliveryOverrides)) {
    assert.ok(byKey.has(key), 'orphan delivery override'); assert.ok(!('enabled' in state), 'outcome cannot enable product');
    if (state.status !== 'planned') assert.ok(byCase.has(key), 'delivery override lacks current case');
  }
  const check = r => {
    const c = byCase.get(r.key); assert.ok(c, `missing evidence: ${r.key}`);
    assert.equal(manifest.expansion.deliveryOverrides[r.key]?.status, 'delivered', `planned delivery evidence: ${r.key}`);
    assert.ok(c.exampleId === r.caseId && c.featureId === r.featureId && c.scenarioId === r.scenarioId, 'missing example identity');
    const result = results.find(x => x.caseId === c.caseId); assert.ok(result, `missing example: ${c.caseId}`);
    assert.equal(result.runId, runId, 'stale result'); assert.equal(result.status, 'PASSED', 'current runner did not pass');
    assert.equal(result.driver, r.driver, 'actual driver mismatch'); assert.equal(result.requestedMode, r.requestedMode, 'actual requested mode mismatch');
    assert.equal(result.fixtureId, c.fixtureId, 'actual fixture identity');
    assert.equal(result.observedOutcome, r.outcomeVariant, 'actual outcome binding');
    assert.equal(c.fixtureId, r.caseId, 'fixture identity mismatch');
    const fixture = fixtures[c.fixtureId]; assert.ok(fixture, 'fixture missing');
    assert.equal(fixture.caseId, r.caseId, 'fixture identity missing');
    const vector = fixtureFile(root, fixture);
    assert.equal(result.fixtureDigest, fixture.sha256, 'executed fixture digest mismatch');
    assert.ok(result.sourceDigest && result.sourceDigest === c.sourceDigest, 'stale result source');
    const selected = fixture.selector ? vector[fixture.selector] : vector;
    assert.ok(selected, 'fixture selector');
    checkDuplicateNames(r, selected);
    for (const req of selected.requests ?? (selected.request ? [selected.request] : [])) {
      if (req.requests) req.requests.forEach(x => validateRequest(x)); else validateRequest(req, selected.effects);
    }
  };
  // Delivered evidence must validate even when it is not yet exposed.
  cases.forEach(c => check(byKey.get(c.key)));
  for (const [exposure, state] of Object.entries(manifest.expansion.variantExposure)) {
    assert.equal(state.status, 'enabled', 'exposure must be enabled explicitly');
    assert.ok(registry.exposed.includes(exposure), 'exposure absent from product registry');
    exposureClosure(manifest, records, exposure).forEach(check);
  }
  for (const exposure of registry.exposed) {
    assert.ok(manifest.expansion.variantExposure[exposure], 'unregistered variant exposure');
    exposureClosure(manifest, records, exposure).forEach(check);
  }
  return { plannedKeys: records.length, executedObligations: cases.length, enabledVariants: registry.exposed.length };
}
// The runner supplies messages from this invocation, with a nonce attachment made
// by the actual World after its real application calls. No checked-in pass files.
export function cucumberResults(messages, runId) {
  const pickles = new Map(), tests = new Map(), starts = new Map(), attachments = new Map(), results = [], executed = new Set();
  for (const m of messages) {
    if (m.pickle) pickles.set(m.pickle.id, m.pickle);
    if (m.testCase) tests.set(m.testCase.id, m.testCase);
    if (m.testCaseStarted) starts.set(m.testCaseStarted.id, m.testCaseStarted);
    if (m.attachment?.mediaType === 'application/vnd.pa.docs-evidence+json') {
      const a = m.attachment; const body = JSON.parse(a.contentEncoding === 'BASE64' ? Buffer.from(a.body, 'base64').toString() : a.body);
      assert.ok(!attachments.has(a.testCaseStartedId), 'duplicate evidence attachment'); attachments.set(a.testCaseStartedId, body);
    }
  }
  for (const m of messages) if (m.testCaseFinished) {
    const finished = m.testCaseFinished, start = starts.get(finished.testCaseStartedId), tc = tests.get(start?.testCaseId), pickle = pickles.get(tc?.pickleId);
    assert.ok(pickle, 'phantom scenario result'); assert.ok(!finished.willBeRetried, 'retries not acceptance evidence');
    assert.ok(!executed.has(pickle.id), 'duplicate scenario execution'); executed.add(pickle.id);
    const steps = messages.filter(x => x.testStepFinished?.testCaseStartedId === finished.testCaseStartedId).map(x => x.testStepFinished);
    assert.deepEqual(steps.map(s => s.testStepId).sort(), tc.testSteps.map(s => s.id).sort(), 'missing/duplicate executed steps');
    const status = steps.every(s => s.testStepResult.status === 'PASSED') ? 'PASSED' : 'NOT_PASSED';
    assert.equal(status, 'PASSED', `not passed: ${pickle.name}`);
    const identity = pickle.name.match(/\[((?:S0[01]|C\d{3})\.[^\]]+)\]$/)?.[1];
    if (pickle.tags.some(t => /^@C\d{3}$/.test(t.name))) assert.ok(identity?.startsWith('C'), 'ledger claim missing concrete caseId');
    const evidence = attachments.get(finished.testCaseStartedId);
    if (identity) {
      assert.ok(evidence, 'missing baseline evidence'); assert.equal(evidence.runId, runId, 'stale result'); assert.equal(evidence.caseId, identity, 'runner identity mismatch');
      results.push({ ...evidence, status, pickle, testCaseId: tc.id });
    }
  }
  assert.equal(executed.size, pickles.size, 'discovered scenarios missing current results');
  assert.ok(messages.some(m => m.testRunFinished?.success === true), 'current run did not finish successfully');
  assert.equal(new Set(results.map(r => r.caseId)).size, results.length, 'duplicate caseId');
  return results;
}
