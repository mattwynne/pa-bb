@docs @bridgeExecution @C011 @F_READ @S_COMMENT_VIEW
Feature: Useful review reads retain denial, missing evidence and exact tab scope
  Scenario Outline: Actual review-view execution [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C011.deniedComments__read.success |
      | C011.deniedComments__read.invalid |
      | C011.deniedComments__read.preservation |
      | C011.deniedComments__read.bounds |
      | C011.deniedComments__read.wrongSubject |
      | C011.missingReviewCoverage__read.success |
      | C011.missingReviewCoverage__read.invalid |
      | C011.missingReviewCoverage__read.preservation |
      | C011.missingReviewCoverage__read.bounds |
      | C011.missingReviewCoverage__read.wrongSubject |
      | C011.tabsAndInline__read.success |
      | C011.tabsAndInline__read.invalid |
      | C011.tabsAndInline__read.preservation |
      | C011.tabsAndInline__read.bounds |
      | C011.tabsAndInline__read.wrongSubject |
