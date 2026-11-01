@F_READ
Feature: Read one exact business section without flattening the rest
  Scenario Outline: Bounded semantic diagnostics and selected original content
    When continuation A read example "<example>" runs through the offline native host
    Then continuation A returned the independent original-content expectation
    Examples:
      | example                 |
      | businessSection         |
      | includeHeading          |
      | ambiguousHeading        |
      | missingEnd              |
      | richIntersection        |
      | siblingSpan             |
      | registryDefinitions     |
      | acceptedPreview         |
      | rejectedPreview         |
      | pagedInspect            |
      | emptySection            |
