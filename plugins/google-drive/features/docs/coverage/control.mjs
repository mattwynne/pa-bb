// Adversarial AUDITOR input generator, not evidence for any product obligation.
// These synthetic current-result records never enter runner.mjs or the registry.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expand, exposureClosure } from './expand.mjs';
import { digest } from './audit.mjs';
export const readManifest = () => JSON.parse(readFileSync(new URL('./obligations.json', import.meta.url)));
export function auditControl(operation = 'docs_plan_style.text/bold__direct') {
  const manifest = readManifest();
  // Audit algorithm controls must never inherit real delivery/exposure state.
  manifest.expansion.deliveryOverrides = {}; manifest.expansion.variantExposure = {};
  for (const gate of Object.values(manifest.externalGates)) { gate.status = 'planned'; gate.evidence = null; }
  const records = expand(manifest);
  const selected = exposureClosure(manifest, records, operation);
  const root = mkdtempSync(join(tmpdir(),'docs-audit-control-'));
  const registry = { operations: {}, exposed: [operation] }, cases = [], results = [], fixtures = {};
  manifest.expansion.variantExposure[operation] = { status: 'enabled' };
  for (const r of selected) {
    const id = r.caseId, path = `${id}.json`, provenance = { source: 'synthetic auditor counterexample control, NOT execution evidence', authorship: 'original independent test input' };
    const vector = { provenance, auditControlOnly: true, before: { text: 'Keep' }, after: { text: 'Keep' } };
    const bytes = JSON.stringify(vector); writeFileSync(join(root,path),bytes);
    fixtures[id] = { path, sha256: digest(bytes), provenance, caseId: id };
    registry.operations[r.operation] ??= { variants: {} };
    registry.operations[r.operation].variants[r.semanticVariant] = { driver: r.driver, schema: r.schema, requestedMode: r.requestedMode, requests: r.requests, capability: 'auditor-control-only' };
    manifest.expansion.deliveryOverrides[r.key] = {status:'delivered', evidence:'synthetic audit control only'};
    cases.push({ ...r, exampleId: id, fixtureId: id, sourceDigest: 'control-source', observedOutcome: r.outcomeVariant });
    results.push({ caseId: id, runId: 'audit-control', status: 'PASSED', observedOutcome: r.outcomeVariant, driver: r.driver, requestedMode: r.requestedMode, fixtureId: id, fixtureDigest: digest(bytes), sourceDigest: 'control-source' });
  }
  return { manifest, registry, cases, results, fixtures, root, runId: 'audit-control', dispose: () => rmSync(root,{recursive:true,force:true}) };
}
export function corruptControl(control, probe) {
  const own = r => r.operation === 'docs_plan_style.text' && r.base === 'bold';
  const remove = fn => { const victim = control.cases.find(fn); if (!victim) throw new Error('missing negative-control victim'); control.cases = control.cases.filter(r => r !== victim); delete control.manifest.expansion.deliveryOverrides[victim.key]; };
  if (probe === 'successOnly') {
    control.cases = control.cases.filter(r => own(r) && r.outcomeVariant === 'success');
    control.manifest.expansion.deliveryOverrides = Object.fromEntries(control.cases.map(r => [r.key,{status:'delivered'}]));
  }
  else if (probe === 'lostReply' || probe === 'finalAuthGate') remove(r => own(r) && r.outcomeVariant === probe);
  else if (probe === 'validation') remove(r => r.kind === 'validation');
  else if (probe === 'invariant') remove(r => r.kind === 'invariant');
  else if (probe === 'enabledPlanned') delete control.manifest.expansion.deliveryOverrides[control.cases[0].key];
  else if (probe === 'missingExample') control.results.shift();
  else if (probe === 'missingFixture') delete control.fixtures[control.cases[0].fixtureId];
  else if (probe === 'unregistered') control.registry.exposed.push('docs_plan_style.phantom/phantom__direct');
  else if (probe === 'phantom') control.cases.push({ ...control.cases[0], caseId: 'phantom', key: 'phantom' });
  else if (probe === 'duplicate') control.cases.push(control.cases[0]);
  else if (probe === 'wrongMode') control.cases[0].requestedMode = 'suggest';
  else if (probe === 'wrongDriver') control.cases[0].driver = 'codec-only';
  else if (probe === 'guardAsSuccess') control.cases.find(r => r.kind === 'validation').kind = 'product';
  else if (probe === 'missingMode') delete control.manifest.bindingCatalog.operationBindings['docs_plan_style.text'].modePolicy;
  else if (probe === 'refusalN' || probe === 'duplicateNameRefusal') control.cases.find(r => r.disposition === 'N' && r.outcomeVariant === 'success' && (probe !== 'duplicateNameRefusal' || r.base === 'createDuplicateName')).observedOutcome = 'refused';
  else if (probe === 'uniqueName') {
    // Real duplicate-name success requires facts; an ordinary unique-name
    // positive fixture must not satisfy that contract.
    const r = control.cases.find(r => r.base === 'createDuplicateName' && r.outcomeVariant === 'success');
    const f = control.fixtures[r.fixtureId];
    const bytes = JSON.stringify({ provenance: f.provenance, before: { text: 'A', ranges: [] }, after: { text: 'A', ranges: [{ id:'one',name:'Unique' }] }, request: {createNamedRange:{name:'Unique'}} });
    writeFileSync(join(control.root, f.path), bytes); f.sha256 = digest(bytes); control.results.find(x => x.caseId === r.caseId).fixtureDigest = f.sha256;
  } else if (probe === 'stale') control.results[0].runId = 'previous-run';
  else if (probe === 'externalUnit') Object.assign(control.manifest.externalGates['applied-code-read-evidence'], { status: 'passed', evidence: {kind:'unit',status:'PASSED'} });
  else if (probe === 'fixtureTamper') writeFileSync(join(control.root,control.fixtures[control.cases[0].fixtureId].path),'{}');
  else throw new Error(`unknown audit probe: ${probe}`);
}
