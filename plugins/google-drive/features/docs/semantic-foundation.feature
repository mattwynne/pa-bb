@F_READ
Feature: Supplemental S02 foundation review regressions
  These source cases do not promote any ledger outcome or expose a tool.

  Scenario Outline: Native read evidence preserves the foundation contract
    When the actual application foundation regression "<regression>" runs
    Then the foundation regression completed without live access

    Examples:
      | regression       |
      | aggregateGrid    |
      | ordinalRoundTrip |
      | scopedReview     |
      | unknownReview    |
      | unknownContent   |
      | outsideParent    |
