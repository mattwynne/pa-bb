@docs @bridgeExecution @C165 @F_ADJACENT @S_METADATA
Feature: Existing native metadata discovery regression

  Scenario Outline: Actual native metadata [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C165.fileMetadata__read.success |
      | C165.fileMetadata__read.invalid |
      | C165.fileMetadata__read.preservation |
      | C165.fileMetadata__read.bounds |
      | C165.fileMetadata__read.wrongSubject |
