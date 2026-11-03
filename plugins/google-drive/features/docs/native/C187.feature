@F_EXEC @S_FINAL_GATE
Feature: C187 exact internal native invariant evidence
  @bridgeExecution
  Scenario Outline: Actual fixed internal native contract [<caseId>]
    When the fixed native production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C187.tokeninfoBarrier__local.success |
      | C187.tokeninfoBarrier__local.counterexample |
      | C187.policyAwait__local.success |
      | C187.policyAwait__local.counterexample |
      | C187.intentPersistence__local.success |
      | C187.intentPersistence__local.counterexample |
      | C187.preDispatchEpoch__local.success |
      | C187.preDispatchEpoch__local.counterexample |
      | C187.cancellation__local.success |
      | C187.cancellation__local.counterexample |
      | C187.expiry__local.success |
      | C187.expiry__local.counterexample |
