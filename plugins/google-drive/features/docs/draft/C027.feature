@F_COMPOSE @S_ORDER
Feature: C027 internal no-write evidence
  @bridgeExecution
  Scenario Outline: Actual supported internal contract [<caseId>]
    When the fixed no-write production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C027.sameRequestRecovery__local.success |
      | C027.sameRequestRecovery__local.counterexample |
      | C027.cancelDraft__local.success |
      | C027.cancelDraft__local.counterexample |
      | C027.noDraftClaims__local.success |
      | C027.noDraftClaims__local.counterexample |
