@docs @bridgeExecution @C005 @F_READ @S_PROJECTIONS
Feature: Independent exact native read projection evidence, never serving exposure
  Scenario Outline: Current owned native projection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                      |
      | C005.text__read.success                      |
      | C005.text__read.invalid                      |
      | C005.text__read.preservation                 |
      | C005.text__read.bounds                       |
      | C005.text__read.wrongSubject                 |
      | C005.structured__read.success                |
      | C005.structured__read.invalid                |
      | C005.structured__read.preservation           |
      | C005.structured__read.bounds                 |
      | C005.structured__read.wrongSubject           |
      | C005.styleAnnotations__read.success          |
      | C005.styleAnnotations__read.invalid          |
      | C005.styleAnnotations__read.preservation     |
      | C005.styleAnnotations__read.bounds           |
      | C005.styleAnnotations__read.wrongSubject     |
      | C005.reviewAnnotations__read.success         |
      | C005.reviewAnnotations__read.invalid         |
      | C005.reviewAnnotations__read.preservation    |
      | C005.reviewAnnotations__read.bounds          |
      | C005.reviewAnnotations__read.wrongSubject    |
      | C005.omitImages__read.success                |
      | C005.omitImages__read.invalid                |
      | C005.omitImages__read.preservation           |
      | C005.omitImages__read.bounds                 |
      | C005.omitImages__read.wrongSubject           |
      | C005.continuation__read.success              |
      | C005.continuation__read.invalid              |
      | C005.continuation__read.preservation         |
      | C005.continuation__read.bounds               |
      | C005.continuation__read.wrongSubject         |
