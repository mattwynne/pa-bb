@F_EXEC @S_CLAIMS
Feature: C191 internal no-write evidence
  @bridgeExecution
  Scenario Outline: Actual supported internal contract [<caseId>]
    When the fixed no-write production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C191.draftNoClaim__local.success |
      | C191.draftNoClaim__local.counterexample |
