@F_EXEC @S_STAGES
Feature: C192 exact internal native invariant evidence
  @bridgeExecution
  Scenario Outline: Actual fixed internal native contract [<caseId>]
    When the fixed native production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C192.notSent__local.success |
      | C192.notSent__local.counterexample |
      | C192.intentCrashUnknown__local.success |
      | C192.intentCrashUnknown__local.counterexample |
      | C192.dispatchRejected__local.success |
      | C192.dispatchRejected__local.counterexample |
      | C192.acknowledged__local.success |
      | C192.acknowledged__local.counterexample |
      | C192.read403AfterAck__local.success |
      | C192.read403AfterAck__local.counterexample |
      | C192.ackSaveFailure__local.success |
      | C192.ackSaveFailure__local.counterexample |
      | C192.currentCallMutationCount__local.success |
      | C192.currentCallMutationCount__local.counterexample |
