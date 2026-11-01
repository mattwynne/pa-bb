@docs @bridgeExecution @C013 @F_SELECT @S_NORMALIZATION
Feature: Native normalization preserves original source and independent policy boundaries
  Scenario Outline: Actual normalized search [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C013.exact__read.success |
      | C013.exact__read.invalid |
      | C013.exact__read.preservation |
      | C013.exact__read.bounds |
      | C013.exact__read.wrongSubject |
      | C013.typographic__read.success |
      | C013.typographic__read.invalid |
      | C013.typographic__read.preservation |
      | C013.typographic__read.bounds |
      | C013.typographic__read.wrongSubject |
      | C013.nfc__read.success |
      | C013.nfc__read.invalid |
      | C013.nfc__read.preservation |
      | C013.nfc__read.bounds |
      | C013.nfc__read.wrongSubject |
      | C013.caseFold__read.success |
      | C013.caseFold__read.invalid |
      | C013.caseFold__read.preservation |
      | C013.caseFold__read.bounds |
      | C013.caseFold__read.wrongSubject |
      | C013.inverseMap__read.success |
      | C013.inverseMap__read.invalid |
      | C013.inverseMap__read.preservation |
      | C013.inverseMap__read.bounds |
      | C013.inverseMap__read.wrongSubject |
      | C013.emoji__read.success |
      | C013.emoji__read.invalid |
      | C013.emoji__read.preservation |
      | C013.emoji__read.bounds |
      | C013.emoji__read.wrongSubject |
      | C013.combining__read.success |
      | C013.combining__read.invalid |
      | C013.combining__read.preservation |
      | C013.combining__read.bounds |
      | C013.combining__read.wrongSubject |
      | C013.rtl__read.success |
      | C013.rtl__read.invalid |
      | C013.rtl__read.preservation |
      | C013.rtl__read.bounds |
      | C013.rtl__read.wrongSubject |
