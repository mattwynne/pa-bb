@docs @bridgeExecution @C006 @F_READ @S_STRUCTURE
Feature: Raw masks are refused by the actual native read schemas
  Scenario Outline: Exact raw-mask exclusion with no provider or storage work [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                      |
      | C006.refuseRawMask__capability.refused        |
      | C006.refuseRawMask__capability.noMutation     |
