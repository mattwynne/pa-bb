@F_READ
Feature: Supplemental partial-range and terminal-envelope boundaries
  These source regressions do not promote semantic obligations or expose tools.

  Scenario Outline: Native reads reject contradictions and accept fitting completion
    When the offline native boundary regression "<regression>" runs
    Then the foundation regression completed without live access

    Examples:
      | regression      |
      | nextSibling     |
      | descendant      |
      | nestedParagraph |
      | row             |
      | inlineSibling   |
      | terminal        |
