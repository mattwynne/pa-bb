@F_EXEC @S_BOUNDS
Feature: C203 internal no-write evidence
  @bridgeExecution
  Scenario Outline: Actual supported internal contract [<caseId>]
    When the fixed no-write production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C203.draftTtl__local.success |
      | C203.draftTtl__local.counterexample |
