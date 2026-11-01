@docs @bridgeExecution @C010 @F_READ @S_VIEWS
Feature: Actual provider views bind read projections without editing authority
  Scenario Outline: Actual native requested and returned view [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C010.inline__read.success |
      | C010.inline__read.invalid |
      | C010.inline__read.preservation |
      | C010.inline__read.bounds |
      | C010.inline__read.wrongSubject |
      | C010.acceptedPreview__read.success |
      | C010.acceptedPreview__read.invalid |
      | C010.acceptedPreview__read.preservation |
      | C010.acceptedPreview__read.bounds |
      | C010.acceptedPreview__read.wrongSubject |
      | C010.rejectedPreview__read.success |
      | C010.rejectedPreview__read.invalid |
      | C010.rejectedPreview__read.preservation |
      | C010.rejectedPreview__read.bounds |
      | C010.rejectedPreview__read.wrongSubject |
      | C010.projectionNotEditProof__read.success |
      | C010.projectionNotEditProof__read.invalid |
      | C010.projectionNotEditProof__read.preservation |
      | C010.projectionNotEditProof__read.bounds |
      | C010.projectionNotEditProof__read.wrongSubject |
