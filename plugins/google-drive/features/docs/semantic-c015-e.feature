@docs @bridgeExecution @C015 @F_SELECT @S_CARDINALITY
Feature: Original local selector cardinality, not read delivery or authoring
  Scenario Outline: Inspected stored-source local invariant [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C015.exactlyOne__local.success |
      | C015.exactlyOne__local.counterexample |
      | C015.explicitOccurrenceZero__local.success |
      | C015.explicitOccurrenceZero__local.counterexample |
      | C015.allExpectedCount__local.success |
      | C015.allExpectedCount__local.counterexample |
      | C015.ambiguous__local.success |
      | C015.ambiguous__local.counterexample |
      | C015.missing__local.success |
      | C015.missing__local.counterexample |
