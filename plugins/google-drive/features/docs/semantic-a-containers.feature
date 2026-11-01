@F_READ
Feature: Original typed values retain their actual containers
  Scenario Outline: Wrong containers are evidence, not known typed values
    When the offline typed-container example "<example>" is read
    Then the original typed-container expectation is satisfied
    Examples:
      | example                   |
      | tabs/namedObject          |
      | columns/numericObject     |
      | tabs/emptyArray           |
      | page/width-array          |
      | nestedScalar/object       |
      | optionalColor/emptyObject |
