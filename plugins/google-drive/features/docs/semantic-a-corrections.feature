@F_READ
Feature: Correct scoped original evidence at section and style boundaries
  Scenario Outline: Read evidence does not invent completeness or inheritance
    When the offline A correction example "<example>" is checked
    Then the original A correction expectation is satisfied
    Examples:
      | example             |
      | terminalUnknown     |
      | absentInlineStyle   |
      | descendantStyles    |
      | wrongPropertyEnum   |
      | unknownDimension    |
