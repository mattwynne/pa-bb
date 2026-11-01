@F_READ
Feature: Supplemental scoped evidence and complete-envelope regressions
  These source cases do not promote ledger outcomes or expose tools.

  Scenario Outline: Native read evidence respects the corrected boundary
    When the offline native residual regression "<regression>" runs
    Then the foundation regression completed without live access

    Examples:
      | regression       |
      | completeEnvelope |
      | otherTab         |
      | otherSegment     |
      | laterSibling     |
      | otherContainer   |
      | target           |
      | ancestor         |
      | dependency       |
      | earlierUnbounded |
