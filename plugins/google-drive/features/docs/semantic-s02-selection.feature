@docs @bridgeExecution
Feature: Original inspection outline and exact read-side selection

@C004 @F_READ @S_OUTLINE
  Scenario Outline: Exact S02 selection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C004.deepLinks__read.bounds |
      | C004.deepLinks__read.invalid |
      | C004.deepLinks__read.preservation |
      | C004.deepLinks__read.success |
      | C004.deepLinks__read.wrongSubject |
      | C004.depth__read.bounds |
      | C004.depth__read.invalid |
      | C004.depth__read.preservation |
      | C004.depth__read.success |
      | C004.depth__read.wrongSubject |
      | C004.headingIds__read.bounds |
      | C004.headingIds__read.invalid |
      | C004.headingIds__read.preservation |
      | C004.headingIds__read.success |
      | C004.headingIds__read.wrongSubject |
      | C004.levels__read.bounds |
      | C004.levels__read.invalid |
      | C004.levels__read.preservation |
      | C004.levels__read.success |
      | C004.levels__read.wrongSubject |
      | C004.sectionExtent__read.bounds |
      | C004.sectionExtent__read.invalid |
      | C004.sectionExtent__read.preservation |
      | C004.sectionExtent__read.success |
      | C004.sectionExtent__read.wrongSubject |

@C016 @F_SELECT @S_SECTION
  Scenario Outline: Exact S02 selection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C016.headingId__local.counterexample |
      | C016.headingId__local.success |
      | C016.headingPath__local.counterexample |
      | C016.headingPath__local.success |
      | C016.includeHeading__local.counterexample |
      | C016.includeHeading__local.success |
      | C016.level__local.counterexample |
      | C016.level__local.success |
      | C016.peerBoundary__local.counterexample |
      | C016.peerBoundary__local.success |

@C017 @F_SELECT @S_HANDLES
  Scenario Outline: Exact S02 selection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C017.node__local.counterexample |
      | C017.node__local.success |
      | C017.span__local.counterexample |
      | C017.span__local.success |
      | C017.staleOrdinal__local.counterexample |
      | C017.staleOrdinal__local.success |
      | C017.transformedIdentity__local.counterexample |
      | C017.transformedIdentity__local.success |

@C020 @F_SELECT @S_TAB_SCOPE
  Scenario Outline: Exact S02 selection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C020.conflictingUrl__local.counterexample |
      | C020.conflictingUrl__local.success |
      | C020.id__local.counterexample |
      | C020.id__local.success |
      | C020.noImplicitFirst__local.counterexample |
      | C020.noImplicitFirst__local.success |
      | C020.path__local.counterexample |
      | C020.path__local.success |
      | C020.url__local.counterexample |
      | C020.url__local.success |
