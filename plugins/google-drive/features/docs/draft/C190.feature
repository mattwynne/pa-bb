@F_EXEC @S_KEYS
Feature: C190 internal no-write evidence
  @bridgeExecution
  Scenario Outline: Actual supported internal contract [<caseId>]
    When the fixed no-write production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C190.serverIssued__local.success |
      | C190.serverIssued__local.counterexample |
      | C190.requestIdRecovery__local.success |
      | C190.requestIdRecovery__local.counterexample |
      | C190.identicalDuplicate__local.success |
      | C190.identicalDuplicate__local.counterexample |
      | C190.differentInputConflict__local.success |
      | C190.differentInputConflict__local.counterexample |
      | C190.failedPlanningConsumed__local.success |
      | C190.failedPlanningConsumed__local.counterexample |
      | C190.cancelledTombstone__local.success |
      | C190.cancelledTombstone__local.counterexample |
      | C190.crossNamespaceCollision__local.success |
      | C190.crossNamespaceCollision__local.counterexample |
