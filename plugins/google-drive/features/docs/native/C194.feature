@F_EXEC @S_INDEPENDENCE
Feature: C194 exact internal native invariant evidence
  @bridgeExecution
  Scenario Outline: Actual fixed internal native contract [<caseId>]
    When the fixed native production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C194.documentedNormalizationOnly__local.success |
      | C194.documentedNormalizationOnly__local.counterexample |
