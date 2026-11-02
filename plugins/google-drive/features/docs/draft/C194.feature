@F_EXEC @S_INDEPENDENCE
Feature: C194 internal no-write evidence
  @bridgeExecution
  Scenario Outline: Actual supported internal contract [<caseId>]
    When the fixed no-write production evidence executes "<caseId>"
    Examples:
      | caseId |
      | C194.noCompilerOracle__local.success |
      | C194.noCompilerOracle__local.counterexample |
      | C194.exactFootprint__local.success |
      | C194.exactFootprint__local.counterexample |
      | C194.unknownFields__local.success |
      | C194.unknownFields__local.counterexample |
