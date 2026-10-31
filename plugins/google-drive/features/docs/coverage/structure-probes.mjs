// Each mode probe targets a declaration class, not a particular inventory count.
export const modeProbes = {
  validationUnknown: m => m.modeExpansionRules['edit-only'].validationModes=['NOT_A_MODE'],
  validationEmpty: m => m.modeExpansionRules['edit-only'].validationModes=[],
  validationDuplicate: m => m.modeExpansionRules['edit-only'].validationModes=['direct','direct'],
  validationUnavailable: m => m.modeExpansionRules['edit-only'].validationModes=['suggest'],
  fixedEmpty: m => m.variantOutcomeOverrides['C108/staleNoFallback'].fixedModes=[],
  fixedUnknown: m => m.variantOutcomeOverrides['C108/staleNoFallback'].fixedModes=['NOT_A_MODE'],
  fixedDuplicate: m => m.variantOutcomeOverrides['C108/staleNoFallback'].fixedModes=['direct','direct'],
  fixedUnavailable: m => m.variantOutcomeOverrides['C108/staleNoFallback'].fixedModes=['suggest'],
  policyEmpty: m => m.modeExpansionRules.eligible.variants=[],
  policyUnknown: m => m.modeExpansionRules.unused={variants:[{mode:'NOT_A_MODE'}]},
  policyDuplicate: m => m.modeExpansionRules.eligible.variants.push({mode:'direct'}),
  policyIllegal: m => m.modeExpansionRules.eligible.variants=[{mode:'read'}],
  variantEmpty: m => m.modeExpansionRules['K7.mode-specific'].byVariant.direct=[],
  variantUnknown: m => m.modeExpansionRules['K7.mode-specific'].byVariant.direct=['NOT_A_MODE'],
  variantIllegal: m => m.modeExpansionRules['K7.mode-specific'].byVariant.direct=['route'],
  variantDuplicate: m => m.modeExpansionRules['K7.mode-specific'].byVariant.direct=['direct','direct'],
  variantMapEmpty: m => m.modeExpansionRules['K7.mode-specific'].byVariant={},
  nonwriterUnavailable: m => m.variantOutcomeOverrides[`C001/${m.rows.C001.groups[0].variants[0]}`]={fixedModes:['local'],reason:'invalid control'},
  controlMissing: m => m.rows.C108.groups[0].variants=['staleNoFallback','deniedNoFallback'],
};
export function breakStructure(m, probe) {
  if (Object.hasOwn(modeProbes, probe)) { modeProbes[probe](m); return; }
  if (probe === 'crossTypo') m.dependencyRules.crossOperationValidations[0].bases=['C034/setResetConflcit'];
  else if (probe === 'crossDeleted') m.rows.C034.groups[0].variants=m.rows.C034.groups[0].variants.filter(v=>v!=='setResetConflict');
  else if (probe === 'crossEmpty') m.dependencyRules.crossOperationValidations[0].bases=[];
  else if (probe === 'stagedTypo') m.dependencyRules.selectionExceptions.codecRows.onlyVariantsForOrdinaryContent=['DOES_NOT_EXIST'];
  else if (probe === 'stagedDeleted') m.dependencyRules.selectionExceptions.codecRows.onlyVariantsForOrdinaryContent.pop();
  else if (probe === 'fullListTypo') m.dependencyRules.selectionExceptions.listComposition.fullForBase='docs_plan_list.preserveCustom/DOES_NOT_EXIST';
  else if (probe === 'operationTypo') m.dependencyRules.semanticWriterExactOperations=['executor.typo'];
  else if (probe === 'rowTypo') m.dependencyRules.families[0].invariantRows.push('C999');
  else if (probe === 'missingMode') m.variantOutcomeOverrides['C034/setResetConflict'].fixedModes=['direct'];
  else if (probe === 'unknownOutcome') m.outcomeProfiles.read.required.push('MADE_UP');
  else if (probe === 'unknownExclusion') m.outcomeProfiles.read.notApplicable.MADE_UP='not relevant';
  else if (probe === 'overlap') m.outcomeProfiles.read.notApplicable.success='not relevant';
  else throw new Error('unknown structure probe');
}
