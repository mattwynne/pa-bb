Feature: Validate observed identity models before continuity comparisons
  Scenario Outline: Derived claims cannot redefine provider observations
    Given the independent B identity correction fixture "<case>"
    Then identity comparison validates both original observed models
    Examples:
      | case                 |
      | unique shift         |
      | actual duplicate     |
      | omitted duplicate    |
      | retyped duplicate    |
      | invented structure   |
      | changed unknown data |
