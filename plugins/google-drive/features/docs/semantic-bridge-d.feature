@docs @bridgeCandidate
Feature: Current-run offline production evidence bridge, not delivery
  @F_READ @S_KIND
  Scenario Outline: Native kind candidate [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                          |
      | C001.nativeDoc__read.success     |

  @F_SELECT @S_PROOF
  Scenario Outline: Production coverage, not the synthetic audit control [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                    |
      | C021.broadDelivered__local.success         |
      | C021.broadDelivered__local.counterexample  |

  @F_ADJACENT @S_METADATA
  Scenario Outline: Existing native metadata path [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                            |
      | C165.fileMetadata__read.success    |
