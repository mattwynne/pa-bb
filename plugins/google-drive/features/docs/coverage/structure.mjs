// Fail-closed reference validation, independent of exposure and execution counts.
import assert from 'node:assert/strict';
const list = (value, name) => {
  assert.ok(Array.isArray(value) && value.length, `empty/missing selector: ${name}`);
  assert.equal(new Set(value).size, value.length, `duplicate selector: ${name}`); return value;
};
const recognizedModes = ['direct','suggest','commentProposal','route','read','local','capability'];
const writerModes = ['direct','suggest','commentProposal','route'];
function modeList(value, name, allowed = recognizedModes) {
  assert.ok(Array.isArray(value) && value.length, `empty/missing mode list: ${name}`);
  assert.equal(new Set(value).size, value.length, `duplicate mode: ${name}`);
  for (const mode of value) {
    assert.ok(recognizedModes.includes(mode), `unknown mode: ${name}/${mode}`);
    assert.ok(allowed.includes(mode), `illegal mode: ${name}/${mode}`);
  }
}
// Validate declarations before any filtering can erase an intended base. Even
// currently unused policies must be well formed; exposure is irrelevant here.
export function validateModeStructure(m) {
  for (const [key,override] of Object.entries(m.variantOutcomeOverrides)) if ('fixedModes' in override)
    modeList(override.fixedModes, `${key}.fixedModes`);
  for (const [policy,rule] of Object.entries(m.modeExpansionRules)) {
    if (!rule || typeof rule !== 'object' || policy === 'nonWriterModes') continue;
    if ('variants' in rule) {
      assert.ok(Array.isArray(rule.variants), `empty/missing mode list: ${policy}.variants`);
      modeList(rule.variants.map(v => v?.mode), `${policy}.variants`, writerModes);
    }
    if ('byVariant' in rule) {
      assert.ok(rule.byVariant && typeof rule.byVariant === 'object' && !Array.isArray(rule.byVariant) && Object.keys(rule.byVariant).length, `empty/missing mode list: ${policy}.byVariant`);
      for (const [base,modes] of Object.entries(rule.byVariant)) modeList(modes, `${policy}.byVariant.${base}`, ['direct','suggest','commentProposal']);
    }
    if ('validationModes' in rule) {
      modeList(rule.validationModes, `${policy}.validationModes`, writerModes);
      for (const mode of rule.validationModes) assert.ok(rule.variants?.some(v => v.mode === mode && !v.unsupported), `unavailable same-mode validation control: ${policy}/${mode}`);
    }
  }
  for (const [profile,mode] of Object.entries(m.modeExpansionRules.nonWriterModes))
    modeList([mode], `nonWriterModes.${profile}`, ['read','local','route','capability']);
}
export function validateProfileStructure(m) {
  validateModeStructure(m);
  const universe = list(m.outcomeUniverse, 'outcomeUniverse');
  const known = new Set(universe);
  for (const name of Object.keys(m.outcomeDefaultNonApplicability)) assert.ok(known.has(name), `unknown default outcome: ${name}`);
  for (const [name,p] of Object.entries(m.outcomeProfiles)) {
    list(p.required, `${name}.required`);
    assert.ok(p.notApplicable && typeof p.notApplicable === 'object', 'missing outcome exclusions');
    for (const outcome of p.required) assert.ok(known.has(outcome), `unknown required outcome: ${name}/${outcome}`);
    for (const [outcome,reason] of Object.entries(p.notApplicable)) {
      assert.ok(known.has(outcome), `unknown nonapplicable outcome: ${name}/${outcome}`);
      assert.ok(!p.required.includes(outcome), `required/nonapplicable overlap: ${name}/${outcome}`);
      assert.ok(typeof reason === 'string' && reason.length, 'missing exclusion reason');
    }
    for (const outcome of universe) assert.ok(p.required.includes(outcome) || p.notApplicable[outcome] || m.outcomeDefaultNonApplicability[outcome], `unclassified outcome: ${name}/${outcome}`);
  }
  for (const [id,row] of Object.entries(m.rows)) {
    assert.ok(Array.isArray(row.groups), `missing groups: ${id}`);
    if (!row.groups.length) list(row.externalGateRefs, `${id}.externalGateRefs`);
    for (const gate of row.externalGateRefs ?? []) assert.ok(m.externalGates[gate]?.ledgerIds.includes(id), `unresolved external gate: ${id}/${gate}`);
    for (const g of row.groups) { assert.ok(m.outcomeProfiles[g.profile], `unknown group profile: ${g.profile}`); list(g.variants, `${id}.variants`); }
  }
  for (const [gate,value] of Object.entries(m.externalGates)) for (const id of list(value.ledgerIds, gate))
    assert.ok(m.rows[id]?.externalGateRefs?.includes(gate), `unresolved external ledger: ${gate}/${id}`);
}
export function validateDependencyStructure(m, records) {
  const d=m.dependencyRules;
  for (const [policy,rule] of Object.entries(m.modeExpansionRules)) {
    if (!rule || typeof rule !== 'object') continue;
    for (const ref of [rule.use,rule.default,rule.overridePolicy].filter(Boolean)) assert.ok(m.modeExpansionRules[ref], `unresolved mode policy: ${policy}/${ref}`);
    for (const [operation,bases] of Object.entries(rule.overrides ?? {})) for (const base of list(bases,'mode override variants'))
      assert.ok(records.some(r=>r.operation===operation&&r.base===base), `unresolved mode override variant: ${operation}/${base}`);
    for (const [base,modes] of Object.entries(rule.byVariant ?? {})) {
      assert.ok(records.some(r=>m.bindingCatalog.operationBindings[r.operation]?.modePolicy===policy&&r.base===base), `unresolved mode-specific base: ${policy}/${base}`);
      for(const mode of list(modes,'variant modes')) assert.ok(['direct','suggest','commentProposal'].includes(mode), `unknown mode-specific mode: ${mode}`);
    }
  }
  for(const [operation,binding] of Object.entries(m.bindingCatalog.operationBindings))
    for(const variants of [binding.fieldsByVariant,binding.requestsByVariant]) for(const base of Object.keys(variants ?? {}))
      assert.ok(records.some(r=>r.operation===operation&&r.base===base), `unresolved binding variant: ${operation}/${base}`);
  for(const operation of Object.keys(m.wireSchemaContract.fieldBindingRequests)) assert.ok(m.bindingCatalog.operationBindings[operation], `unresolved field-binding operation: ${operation}`);
  for(const key of Object.keys(m.namedRangeDuplicateFixtureFacts)) assert.ok(records.some(r=>r.key===key), `unresolved duplicate-name fact key: ${key}`);
  for (const r of records.filter(r => ['validation','failure-invariant','no-op'].includes(r.kind)))
    assert.ok(records.some(control => control.operation === r.operation && control.requestedMode === r.requestedMode && ['product','control'].includes(control.kind)), `missing same-mode route/control: ${r.operation}/${r.base}/${r.requestedMode}`);
  const operations=new Set(records.map(r=>r.operation));
  const rows = (ids,name) => { for(const id of list(ids,name)) assert.ok(records.some(r=>r.ledgerId===id && r.profile==='invariant'), `unresolved invariant row: ${name}/${id}`); };
  const ops = (names,label) => { for(const op of list(names,label)) assert.ok(operations.has(op), `unresolved operation: ${label}/${op}`); };
  const prefixes = (values,label) => { for(const prefix of list(values,label)) assert.ok([...operations].some(op=>op.startsWith(prefix)), `unresolved prefix: ${label}/${prefix}`); };
  const variants=(row,values,label)=>{ for(const v of list(values,label)) assert.ok(records.some(r=>r.ledgerId===row&&r.base===v&&r.profile==='invariant'), `unresolved staged variant: ${label}/${row}/${v}`); };
  for (const r of records) assert.ok(['direct','suggest','commentProposal','read','local','route','capability'].includes(r.requestedMode), `unknown applicable mode: ${r.requestedMode}`);
  for(const kind of list(d.sameOperationKinds,'sameOperationKinds')) assert.ok(['validation','failure-invariant','no-op'].includes(kind), `unknown dependency kind: ${kind}`);
  assert.ok(Array.isArray(d.crossOperationValidations) && d.crossOperationValidations.length, 'missing cross-operation validations');
  for(const rule of d.crossOperationValidations) {
    prefixes(rule.prefixes,'crossOperationValidations.prefixes');
    assert.equal(rule.mode,'same-requested-mode','unknown dependency mode selector');
    for(const base of list(rule.bases,'crossOperationValidations.bases')) {
      const selected=records.filter(r=>`${r.ledgerId}/${r.base}`===base);
      assert.ok(selected.length && selected.every(r=>r.kind==='validation'), `unresolved cross-operation validation: ${base}`);
      const targets=records.filter(r=>r.kind==='product'&&rule.prefixes.some(p=>r.operation.startsWith(p)));
      for(const mode of new Set(targets.map(r=>r.requestedMode))) assert.ok(selected.some(r=>r.requestedMode===mode), `missing applicable dependency mode: ${base}/${mode}`);
    }
  }
  prefixes(d.semanticWriterPrefixes,'semanticWriterPrefixes'); rows(d.semanticWriterInvariantRows,'semanticWriterInvariantRows'); ops(d.semanticWriterExactOperations,'semanticWriterExactOperations');
  assert.ok(Array.isArray(d.families)&&d.families.length,'missing families');
  for(const family of d.families) { prefixes(family.prefixes,'family prefixes'); rows(family.invariantRows,'family rows'); }
  const ex=d.selectionExceptions; assert.ok(ex?.codecRows&&ex.listComposition&&ex.wordRows,'missing staged selectors');
  rows([ex.codecRows.row],'codec row'); variants(ex.codecRows.row,ex.codecRows.onlyVariantsForOrdinaryContent,'ordinary content'); ops(ex.codecRows.fullForOperations,'full codec operations');
  rows([ex.listComposition.row],'list row'); variants(ex.listComposition.row,ex.listComposition.ordinaryVariants,'ordinary lists');
  assert.ok(records.some(r=>`${r.operation}/${r.base}`===ex.listComposition.fullForBase), 'unresolved full list base');
  rows(ex.wordRows.rows,'word rows'); ops([ex.wordRows.onlyOperation],'word operation');
  for(const [op,ids] of Object.entries(d.extraOperationRows)) {ops([op],'extra operation');rows(ids,'extra operation rows');}
  prefixes(d.snapshotReaderPrefixes,'snapshot readers');ops(d.lifecycleControlOperations,'lifecycle controls');
  // The exception is a stage boundary, not an arbitrary convenient subset:
  // all variants in the earliest invariant group must be retained.
  for(const [row,selected,label] of [[ex.codecRows.row,ex.codecRows.onlyVariantsForOrdinaryContent,'ordinary content'],[ex.listComposition.row,ex.listComposition.ordinaryVariants,'ordinary lists']]) {
    const all=records.filter(r=>r.ledgerId===row&&r.profile==='invariant');
    const earliest=Math.min(...all.map(r=>parseInt(r.slice.slice(1),10)));
    const expected=[...new Set(all.filter(r=>parseInt(r.slice.slice(1),10)===earliest).map(r=>r.base))].sort();
    assert.deepEqual([...selected].sort(),expected,`incomplete staged selector: ${label}`);
  }
}
