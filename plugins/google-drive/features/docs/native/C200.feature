@F_APPROVAL @S_POLICY
Feature: C200 exact internal native invariant evidence
  @bridgeExecution
  Scenario Outline: Actual fixed internal native contract [<caseId>]
    When the fixed native production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C200.cancel__local.success |
      | C200.cancel__local.counterexample |
      | C200.enabledCard__local.success |
      | C200.enabledCard__local.counterexample |
