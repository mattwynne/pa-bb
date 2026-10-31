// Runs Cucumber, then audits this invocation's actual message stream. Outputs to
// a fresh temporary directory only; never reads saved results as current passes.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, cucumberResults, fixtureFile, auditEvidence } from './audit.mjs';
import { allClosures, expand } from './expand.mjs';
import { assertProductIntake } from './product-intake.mjs';
export const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
export function sourceDigest(root = packageRoot) {
  const files = [];
  // Include top-level registration/schema/server modules, all local shared
  // helpers, config and dependency lock. Exclude deployments/dependencies and
  // unit-test transpilation scratch files, never runtime source.
  const walk = path => { for (const name of readdirSync(join(root, path)).sort()) {
    if (!path && ['node_modules','dist','test','.git'].includes(name)) continue;
    const p = join(path, name); if (statSync(join(root,p)).isDirectory()) walk(p); else files.push(p);
  } };
  walk('');
  return digest(files.map(p => `${p}\0${digest(readFileSync(join(root,p)))}`).join('\n'));
}
export function auditBaseline(messages, runId, fingerprint, root = packageRoot) {
  const json = path => JSON.parse(readFileSync(join(root, path)));
  const results = cucumberResults(messages, runId).filter(r => r.caseId.startsWith('S')), registry = json('features/docs/coverage/baseline.json'), fixtures = json('features/docs/coverage/fixtures/index.json');
  assert.equal(new Set(registry.cases.map(c => c.caseId)).size, registry.cases.length, 'duplicate baseline caseId');
  assert.deepEqual(results.map(r => r.caseId).sort(), registry.cases.map(c => c.caseId).sort(), 'baseline discovery/reverse orphan mismatch');
  assert.deepEqual(Object.keys(fixtures).filter(id => id.startsWith('S')).sort(), registry.cases.map(c => c.fixtureId).sort(), 'baseline fixture orphan');
  for (const c of registry.cases) {
    const r = results.find(r => r.caseId === c.caseId); assert.ok(r, `missing example: ${c.caseId}`);
    assert.equal(r.pickle.uri, c.feature, 'feature identity');
    assert.equal(r.sourceDigest, fingerprint, 'stale result source');
    assert.equal(r.driver, c.driver, 'actual driver'); assert.equal(r.requestedMode, c.requestedMode, 'requested mode');
    assert.equal(r.fixtureId, c.fixtureId, 'fixture identity');
    const f = fixtures[c.fixtureId], vector = fixtureFile(root, f); assert.equal(r.fixtureDigest, f.sha256, 'executed fixture digest');
    assert.equal(vector.caseId, c.caseId); assert.equal(vector.driver, c.driver);
    const wireBytes = readFileSync(join(root, vector.vector.path)); assert.equal(digest(wireBytes), vector.vector.sha256, 'wire vector digest');
    assert.equal(r.vectorDigest, vector.vector.sha256, 'executed vector digest');
    assert.ok(r.realSqlite && r.closedHttp && r.applicationInvoked, 'baseline did not exercise real path');
    // Gherkin AST IDs connect the compiled pickle to the actual Scenario and
    // Examples row (not invented scenario tags or a checked-in passed flag).
    const document = messages.find(m => m.gherkinDocument?.uri === c.feature)?.gherkinDocument;
    assert.ok(document && r.pickle.astNodeIds.length, 'missing Examples AST');
    const astIds = new Set(); const visit = v => { if (!v || typeof v !== 'object') return; if (v.id) astIds.add(v.id); Object.values(v).forEach(x => Array.isArray(x) ? x.forEach(visit) : visit(x)); }; visit(document);
    assert.ok(r.pickle.astNodeIds.every(id => astIds.has(id)), 'missing Examples row');
    const scenarios = document.feature.children.flatMap(child => child.scenario ? [child.scenario] : child.rule?.children?.flatMap(x => x.scenario ? [x.scenario] : []) ?? []);
    const scenario = scenarios.find(s => r.pickle.astNodeIds.includes(s.id)); assert.ok(scenario, 'missing scenario');
    if (scenario.examples.length) {
      const table = scenario.examples.find(e => e.tableBody.some(row => r.pickle.astNodeIds.includes(row.id)));
      assert.ok(table, 'missing Examples row'); const column = table.tableHeader.cells.findIndex(cell => cell.value === 'caseId');
      assert.ok(column >= 0, 'missing caseId column');
      assert.equal(table.tableBody.find(row => r.pickle.astNodeIds.includes(row.id)).cells[column].value, c.caseId, 'Examples caseId mismatch');
    }
  }
  return { baseline: results.filter(r => r.caseId.startsWith('S00')).length, s01ApplicationCases: results.filter(r => r.caseId.startsWith('S01')).length };
}
export function run() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-docs-acceptance-')), runId = randomUUID(), fingerprint = sourceDigest(), output = join(dir, 'messages.ndjson');
  const result = spawnSync(process.execPath, ['node_modules/@cucumber/cucumber/bin/cucumber.js','--profile','docs','--format',`message:${output}`], {
    cwd: packageRoot, stdio: 'inherit', env: { ...process.env, DOCS_ACCEPTANCE_RUN_ID: runId, DOCS_ACCEPTANCE_SOURCE_DIGEST: fingerprint }
  });
  console.log(`Docs current-run evidence: ${dir}`);
  assert.equal(result.status, 0, 'Cucumber failed; no coverage credit');
  assert.equal(sourceDigest(), fingerprint, 'source changed during run');
  const messages = readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
  const baseline = auditBaseline(messages, runId, fingerprint);
  const manifest = JSON.parse(readFileSync(join(packageRoot,'features/docs/coverage/obligations.json')));
  const registry = JSON.parse(readFileSync(join(packageRoot,'features/docs/coverage/registry.json')));
  const semanticResults = cucumberResults(messages, runId).filter(r => r.caseId.startsWith('C'));
  const fixtures = JSON.parse(readFileSync(join(packageRoot,'features/docs/coverage/fixtures/index.json')));
  assertProductIntake({ manifest, registry, results: semanticResults, fixtures, root: packageRoot });
  const inventory = new Map(expand(manifest).map(r => [r.caseId,r]));
  const cases = semanticResults.map(result => {
    const expected = inventory.get(result.caseId); assert.ok(expected, 'phantom scenario');
    assert.equal(result.key, expected.key, 'actual obligation binding');
    assert.equal(result.sourceDigest, fingerprint, 'stale semantic source');
    const tags = result.pickle.tags.map(t => t.name);
    assert.ok(tags.includes(`@${expected.featureId}`) && tags.includes(`@${expected.scenarioId}`), 'missing actual feature/scenario identity');
    const document = messages.find(m => m.gherkinDocument?.uri === result.pickle.uri)?.gherkinDocument;
    const scenarios = document?.feature.children.flatMap(c => c.scenario ? [c.scenario] : c.rule?.children?.flatMap(x => x.scenario ? [x.scenario] : []) ?? []) ?? [];
    const scenario = scenarios.find(s => result.pickle.astNodeIds.includes(s.id)); assert.ok(scenario, 'phantom scenario');
    if (scenario.examples.length) {
      const example = scenario.examples.find(e => e.tableBody.some(row => result.pickle.astNodeIds.includes(row.id)));
      const column = example?.tableHeader.cells.findIndex(c => c.value === 'caseId'); assert.ok(column >= 0, 'missing Examples caseId');
      assert.equal(example.tableBody.find(row => result.pickle.astNodeIds.includes(row.id)).cells[column].value, result.caseId, 'Examples identity');
    }
    return { ...result, featureId: expected.featureId, scenarioId: expected.scenarioId, exampleId: result.caseId };
  });
  const coverage = auditEvidence({ manifest, registry, cases, results: semanticResults, fixtures, root: packageRoot, runId });
  const summary = { runId, sourceDigest: fingerprint, ...baseline, ...coverage, exposureBundles: allClosures(manifest, expand(manifest)).size,
    cucumberScenarios: messages.filter(m => m.testCaseFinished).length, externalEvidence: 'separate; no rendered/applied-code credit' };
  writeFileSync(join(dir,'summary.json'), JSON.stringify(summary,null,2)+'\n'); console.log(JSON.stringify(summary));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
