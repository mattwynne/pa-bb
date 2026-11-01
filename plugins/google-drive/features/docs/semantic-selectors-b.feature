Feature: Bounded semantic selectors and immutable read evidence
  Scenario Outline: Read-only B contract through the native tool boundary
    Given the independent B read fixture for "<case>"
    Then the B native selector and stored evidence agree with the independent facts
    Examples:
      | case                  |
      | exact heading text    |
      | typed heading level   |
      | literal source map    |
      | normalization budget  |
      | cursor corruption     |
      | delivery corruption   |
