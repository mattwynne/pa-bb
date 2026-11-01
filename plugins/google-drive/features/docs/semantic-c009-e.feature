@docs @bridgeExecution @C009 @F_READ @S_COVERAGE
Feature: Exact snapshot coverage evidence through native and private store calls
  Scenario Outline: Current owned snapshot invariant [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                            |
      | C009.cursorExpiry__local.success                   |
      | C009.cursorExpiry__local.counterexample            |
      | C009.cursorReplay__local.success                   |
      | C009.cursorReplay__local.counterexample            |
      | C009.draftPinnedEvidence__local.success            |
      | C009.draftPinnedEvidence__local.counterexample     |
      | C009.empty__local.success                          |
      | C009.empty__local.counterexample                   |
      | C009.overrun__local.success                        |
      | C009.overrun__local.counterexample                 |
      | C009.partial__local.success                        |
      | C009.partial__local.counterexample                 |
      | C009.snapshotExpiry__local.success                 |
      | C009.snapshotExpiry__local.counterexample          |
      | C009.wrongThread__local.success                    |
      | C009.wrongThread__local.counterexample             |
