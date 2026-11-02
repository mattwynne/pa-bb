@docs @bridgeCandidate
Feature: Current-run offline production evidence bridge, not delivery
  @F_SELECT @S_PROOF
  Scenario Outline: Production coverage, not the synthetic audit control [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                    |
      | C021.broadDelivered__local.success         |
      | C021.broadDelivered__local.counterexample  |
