@docs @bridgeExecution @C007 @F_READ @S_RICH_CELLS
Feature: Actual physical rich-cell reads without editing or rendering authority
  Scenario Outline: Current bounded rich-cell evidence [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                      |
      | C007.adjacentRuns__read.success              |
      | C007.adjacentRuns__read.invalid              |
      | C007.adjacentRuns__read.preservation         |
      | C007.adjacentRuns__read.bounds               |
      | C007.adjacentRuns__read.wrongSubject         |
      | C007.inlineObject__read.success              |
      | C007.inlineObject__read.invalid              |
      | C007.inlineObject__read.preservation         |
      | C007.inlineObject__read.bounds               |
      | C007.inlineObject__read.wrongSubject         |
      | C007.nestedTable__read.success               |
      | C007.nestedTable__read.invalid               |
      | C007.nestedTable__read.preservation          |
      | C007.nestedTable__read.bounds                |
      | C007.nestedTable__read.wrongSubject          |
      | C007.paragraphNewlines__read.success         |
      | C007.paragraphNewlines__read.invalid         |
      | C007.paragraphNewlines__read.preservation    |
      | C007.paragraphNewlines__read.bounds          |
      | C007.paragraphNewlines__read.wrongSubject    |
