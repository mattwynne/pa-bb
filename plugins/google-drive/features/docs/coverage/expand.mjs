// Test-only implementation of K10. No production imports or generated pass records.
import assert from 'node:assert/strict';
import { validateProfileStructure, validateDependencyStructure } from './structure.mjs';
export function bindingFor(m, operation) {
  const b = m.bindingCatalog.operationBindings[operation] ?? Object.entries(m.bindingCatalog.prefixBindings)
    .filter(([prefix]) => operation.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  assert.ok(b?.schema && (b.registration || b.internal), `binding missing: ${operation}`);
  return b;
}
function modesFor(m, group, base, binding, override) {
  if (override.fixedModes) {
    assert.ok(override.reason, 'fixed mode requires reason');
    if (['native','noCas'].includes(group.profile)) {
      const allowed = binding.modePolicy === 'K7.mode-specific'
        ? Object.values(m.modeExpansionRules['K7.mode-specific'].byVariant).flat().map(mode => ({mode}))
        : modesFor(m, group, base, binding, {});
      for (const mode of override.fixedModes) assert.ok(allowed.some(v => v.mode === mode && (!v.unsupported || override.profile === 'blocked')), 'fixed-mode control unavailable');
    } else {
      for (const mode of override.fixedModes) assert.equal(mode, m.modeExpansionRules.nonWriterModes[group.profile], 'fixed-mode nonwriter route unavailable');
    }
    return override.fixedModes.map(mode => ({ mode }));
  }
  if (!['native', 'noCas'].includes(group.profile)) {
    const mode = m.modeExpansionRules.nonWriterModes[group.profile];
    assert.ok(mode, `nonwriter mode missing: ${group.profile}`); return [{ mode }];
  }
  let policy = binding.modePolicy;
  assert.ok(policy, `native mode binding missing: ${group.operation}`);
  const visited = new Set();
  while (true) {
    assert.ok(!visited.has(policy), 'mode cycle'); visited.add(policy);
    const rule = m.modeExpansionRules[policy]; assert.ok(rule, `mode policy missing: ${policy}`);
    if (rule.use) { policy = rule.use; continue; }
    if (rule.default) {
      policy = rule.overrides[group.operation]?.includes(base) ? rule.overridePolicy : rule.default; continue;
    }
    if (rule.byVariant) {
      assert.ok(rule.byVariant[base], `mode variant missing: ${base}`);
      return rule.byVariant[base].map(mode => ({ mode }));
    }
    assert.ok(rule.variants, 'mode variants missing');
    return rule.variants.filter(v => !(['guard', 'noOp'].includes(override.profile) && rule.validationModes && !rule.validationModes.includes(v.mode)));
  }
}
const inherited = (value, fallback) => !value || value === 'inherit' ? fallback : value;
export function expand(m) {
  assert.equal(m.designRevision, 3);
  validateProfileStructure(m);
  assert.deepEqual(Object.keys(m.rows).sort(), Array.from({ length: 211 }, (_, i) => `C${String(i + 1).padStart(3, '0')}`), 'ledger IDs');
  // Resolve every intended base before emitting records: legal fixed selectors
  // and filters must not depend on whether expansion happens to visit a survivor.
  const resolvedModes = new Map();
  for (const [id,row] of Object.entries(m.rows)) for (const group of row.groups) {
    const binding = bindingFor(m, group.operation), bases = new Map();
    for (const base of group.variants) {
      const modes = modesFor(m, group, base, binding, m.variantOutcomeOverrides[`${id}/${base}`] ?? {});
      assert.ok(modes.length, `base has no resolved modes: ${id}/${base}`); bases.set(base, modes);
    }
    resolvedModes.set(group, bases);
  }
  const records = [], usedOverrides = new Set(), keys = new Set(), examples = new Set();
  for (const [ledgerId, row] of Object.entries(m.rows)) for (const group of row.groups) {
    const binding = bindingFor(m, group.operation);
    assert.ok(['N', 'P', 'R', 'B', 'X'].includes(group.disposition), 'disposition');
    // A fixed override must not conceal an absent native binding.
    if (['native', 'noCas'].includes(group.profile)) assert.ok(binding.modePolicy, `native mode binding missing: ${group.operation}`);
    for (const base of group.variants) {
      const overrideKey = `${ledgerId}/${base}`, override = m.variantOutcomeOverrides[overrideKey] ?? {};
      if (m.variantOutcomeOverrides[overrideKey]) usedOverrides.add(overrideKey);
      const modes = resolvedModes.get(group).get(base), start = records.length;
      for (const modeRule of modes) {
        const requestedMode = modeRule.mode;
        const profile = modeRule.unsupported ? 'blocked' : override.profile ?? inherited(modeRule.profile, group.profile);
        const disposition = modeRule.unsupported ? 'B' : override.disposition ?? inherited(modeRule.disposition, group.disposition);
        const semanticVariant = `${base}__${modeRule.unsupported ? 'suggestRefused' : requestedMode}`;
        const kind = modeRule.unsupported ? 'capability-exclusion' : override.kind ?? (profile === 'invariant' ? (binding.registration ? 'control' : 'invariant') : ['blocked', 'route'].includes(profile) ? 'capability' : 'product');
        const outcomes = m.outcomeProfiles[profile]; assert.ok(outcomes, `profile missing: ${profile}`);
        assert.equal(new Set(outcomes.required).size, outcomes.required.length, 'duplicate outcomes');
        for (const outcome of m.outcomeUniverse) assert.ok(outcomes.required.includes(outcome) || outcomes.notApplicable[outcome] || m.outcomeDefaultNonApplicability[outcome], `unclassified outcome: ${profile}/${outcome}`);
        for (const outcomeVariant of outcomes.required) {
          const key = `${ledgerId}/${group.operation}/${semanticVariant}/${outcomeVariant}`;
          const caseId = `${ledgerId}.${semanticVariant}.${outcomeVariant}`;
          assert.ok(!keys.has(key) && !examples.has(caseId), `duplicate caseId/key: ${caseId}`); keys.add(key); examples.add(caseId);
          records.push({ key, caseId, ledgerId, operation: group.operation, base, semanticVariant, requestedMode, profile, disposition, kind,
            featureId: `F_${row.feature}`, scenarioId: `S_${row.scenario}`, outcomeVariant,
            driver: binding.publicDriver?.tool ?? binding.registration ?? binding.internal, schema: binding.schema,
            requests: binding.requestsByVariant?.[base] ?? binding.requests ?? [], slice: group.slice,
            earliestSlice: requestedMode === 'suggest' && parseInt(group.slice.slice(1), 10) < 10 ? 'S10' : group.slice,
            status: 'planned' });
        }
      }
      assert.ok(records.length > start, `base has no resolved obligations: ${overrideKey}`);
    }
  }
  assert.deepEqual([...usedOverrides].sort(), Object.keys(m.variantOutcomeOverrides).sort(), 'orphan outcome override');
  validateDependencyStructure(m, records);
  return records.sort((a, b) => a.key.localeCompare(b.key, 'en'));
}
export function exposureClosure(m, records, exposureKey) {
  validateProfileStructure(m); validateDependencyStructure(m, records);
  return closureUnchecked(m, records, exposureKey);
}
function closureUnchecked(m, records, exposureKey) {
  const own = records.filter(r => `${r.operation}/${r.semanticVariant}` === exposureKey);
  assert.ok(own.length, `unregistered variant: ${exposureKey}`);
  const primary = own[0], d = m.dependencyRules;
  assert.ok(['product', 'control'].includes(primary.kind), 'guard/invariant cannot expose product success');
  const required = new Map(own.map(r => [r.key, r]));
  const add = predicate => records.filter(predicate).forEach(r => required.set(r.key, r));
  add(r => r.operation === primary.operation && r.requestedMode === primary.requestedMode &&
    (d.sameOperationKinds.includes(r.kind) || r.profile === 'invariant'));
  for (const rule of d.crossOperationValidations) if (rule.prefixes.some(p => primary.operation.startsWith(p)))
    add(r => rule.bases.includes(`${r.ledgerId}/${r.base}`) && r.requestedMode === primary.requestedMode);
  const rows = new Set();
  const writer = d.semanticWriterPrefixes.some(p => primary.operation.startsWith(p));
  if (writer) {
    d.semanticWriterInvariantRows.forEach(r => rows.add(r));
    for (const operation of d.semanticWriterExactOperations) assert.ok(records.some(r => r.operation === operation), `missing dependency operation: ${operation}`);
    add(r => d.semanticWriterExactOperations.includes(r.operation));
  }
  const families = d.families.filter(f => f.prefixes.some(p => primary.operation.startsWith(p)));
  if (['native', 'noCas'].includes(primary.profile)) assert.ok(families.length, 'writer without dependency family');
  families.forEach(f => f.invariantRows.forEach(r => rows.add(r)));
  (d.extraOperationRows[primary.operation] ?? []).forEach(r => rows.add(r));
  if (writer && ['suggest', 'commentProposal'].includes(primary.requestedMode)) ['C115','C118','C120','C121'].forEach(r => rows.add(r));
  if (d.snapshotReaderPrefixes.some(p => primary.operation.startsWith(p))) rows.add('C009');
  if (d.lifecycleControlOperations.includes(primary.operation)) ['C027','C190','C191','C200','C203'].forEach(r => rows.add(r));
  const ex = d.selectionExceptions;
  for (const row of rows) assert.ok(records.some(r => r.ledgerId === row && r.profile === 'invariant'), `missing invariant dependency: ${row}`);
  add(r => {
    if (r.profile !== 'invariant' || !rows.has(r.ledgerId)) return false;
    if (r.ledgerId === ex.codecRows.row && !ex.codecRows.fullForOperations.includes(primary.operation)) return ex.codecRows.onlyVariantsForOrdinaryContent.includes(r.base);
    if (r.ledgerId === ex.listComposition.row && `${primary.operation}/${primary.base}` !== ex.listComposition.fullForBase) return ex.listComposition.ordinaryVariants.includes(r.base);
    if (ex.wordRows.rows.includes(r.ledgerId) && primary.operation !== ex.wordRows.onlyOperation) return false;
    return true;
  });
  return [...required.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'));
}
export function allClosures(m, records) {
  validateProfileStructure(m); validateDependencyStructure(m, records);
  return new Map([...new Set(records.filter(r => ['product', 'control'].includes(r.kind)).map(r => `${r.operation}/${r.semanticVariant}`))]
    .sort().map(key => [key, closureUnchecked(m, records, key)]));
}
