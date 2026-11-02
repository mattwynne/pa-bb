@docs @bridgeExecution @C021 @F_SELECT @S_PROOF
Feature: Exact typed read-effect witnesses without authoring authority
  Scenario Outline: Current independent witness facts [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C021.broadDelivered__local.counterexample |
      | C021.broadDelivered__local.success |
      | C021.completePreview__local.counterexample |
      | C021.completePreview__local.success |
      | C021.generatedNode__local.counterexample |
      | C021.generatedNode__local.success |
      | C021.historyNotCurrent__local.counterexample |
      | C021.historyNotCurrent__local.success |
      | C021.namedStyleIndirect__local.counterexample |
      | C021.namedStyleIndirect__local.success |
      | C021.narrowLiteral__local.counterexample |
      | C021.narrowLiteral__local.success |
      | C021.siblingNotCovered__local.counterexample |
      | C021.siblingNotCovered__local.success |
      | C021.styleFromMetadata__local.counterexample |
      | C021.styleFromMetadata__local.success |
