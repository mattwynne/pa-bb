@docs @bridgeExecution @C006 @F_READ @S_STRUCTURE
Feature: Independent readable structural registries, never write or serving authority
  Scenario Outline: Current owned native structural diagnostics [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                |
      | C006.styles__read.success              |
      | C006.styles__read.invalid              |
      | C006.styles__read.preservation         |
      | C006.styles__read.bounds               |
      | C006.styles__read.wrongSubject         |
      | C006.objects__read.success             |
      | C006.objects__read.invalid             |
      | C006.objects__read.preservation        |
      | C006.objects__read.bounds              |
      | C006.objects__read.wrongSubject        |
      | C006.ranges__read.success              |
      | C006.ranges__read.invalid              |
      | C006.ranges__read.preservation         |
      | C006.ranges__read.bounds               |
      | C006.ranges__read.wrongSubject         |
      | C006.suggestions__read.success         |
      | C006.suggestions__read.invalid         |
      | C006.suggestions__read.preservation    |
      | C006.suggestions__read.bounds          |
      | C006.suggestions__read.wrongSubject    |
