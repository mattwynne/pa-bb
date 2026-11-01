@docs @bridgeExecution @C003 @F_READ @S_SEGMENTS
Feature: Explicit stored segment reads preserve tab and segment identity
  Scenario Outline: Actual native scoped segment read [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C003.body__read.success |
      | C003.body__read.invalid |
      | C003.body__read.preservation |
      | C003.body__read.bounds |
      | C003.body__read.wrongSubject |
      | C003.header__read.success |
      | C003.header__read.invalid |
      | C003.header__read.preservation |
      | C003.header__read.bounds |
      | C003.header__read.wrongSubject |
      | C003.footer__read.success |
      | C003.footer__read.invalid |
      | C003.footer__read.preservation |
      | C003.footer__read.bounds |
      | C003.footer__read.wrongSubject |
      | C003.footnote__read.success |
      | C003.footnote__read.invalid |
      | C003.footnote__read.preservation |
      | C003.footnote__read.bounds |
      | C003.footnote__read.wrongSubject |
