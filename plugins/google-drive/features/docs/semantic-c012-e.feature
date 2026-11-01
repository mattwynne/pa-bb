@docs @bridgeExecution @C012 @F_SELECT @S_LITERAL
Feature: Native literal search keeps source boundaries and honest bounded results
  Scenario Outline: Actual literal search [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C012.crossRun__read.success |
      | C012.crossRun__read.invalid |
      | C012.crossRun__read.preservation |
      | C012.crossRun__read.bounds |
      | C012.crossRun__read.wrongSubject |
      | C012.paragraphBoundary__read.success |
      | C012.paragraphBoundary__read.invalid |
      | C012.paragraphBoundary__read.preservation |
      | C012.paragraphBoundary__read.bounds |
      | C012.paragraphBoundary__read.wrongSubject |
      | C012.chipBoundary__read.success |
      | C012.chipBoundary__read.invalid |
      | C012.chipBoundary__read.preservation |
      | C012.chipBoundary__read.bounds |
      | C012.chipBoundary__read.wrongSubject |
      | C012.boundedContext__read.success |
      | C012.boundedContext__read.invalid |
      | C012.boundedContext__read.preservation |
      | C012.boundedContext__read.bounds |
      | C012.boundedContext__read.wrongSubject |
