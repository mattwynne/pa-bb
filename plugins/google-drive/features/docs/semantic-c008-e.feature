@docs @bridgeExecution @C008 @F_READ @S_OPAQUE
Feature: Opaque API evidence and losses without interpreted or rendered authority
  Scenario Outline: Actual bounded opaque read [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                              |
      | C008.autoText__read.success          |
      | C008.autoText__read.invalid          |
      | C008.autoText__read.preservation     |
      | C008.autoText__read.bounds           |
      | C008.autoText__read.wrongSubject     |
      | C008.drawing__read.success           |
      | C008.drawing__read.invalid           |
      | C008.drawing__read.preservation      |
      | C008.drawing__read.bounds            |
      | C008.drawing__read.wrongSubject      |
      | C008.equation__read.success          |
      | C008.equation__read.invalid          |
      | C008.equation__read.preservation     |
      | C008.equation__read.bounds           |
      | C008.equation__read.wrongSubject     |
      | C008.toc__read.success               |
      | C008.toc__read.invalid               |
      | C008.toc__read.preservation          |
      | C008.toc__read.bounds                |
      | C008.toc__read.wrongSubject          |
      | C008.unknown__read.success           |
      | C008.unknown__read.invalid           |
      | C008.unknown__read.preservation      |
      | C008.unknown__read.bounds            |
      | C008.unknown__read.wrongSubject      |
