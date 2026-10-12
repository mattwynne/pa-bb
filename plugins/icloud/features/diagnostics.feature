Feature: Private, useful sync diagnostics without changing file safety
  Background:
    Given a syncing installation with diagnostic history

  Scenario: Successful syncs keep a bounded summary instead of noisy success logs
    When a measured diagnostic sync succeeds
    Then its history includes stage durations and measured cloud transfer counts
    And no routine success log or private diagnostic field is emitted

  Scenario: A failed command records its stage and safe exit evidence
    When a diagnostic cloud copy fails with exit code 4
    Then the failed history identifies a missing-file command exit without provider text
    And the diagnostic folder pauses without retrying or changing its last success

  Scenario: Completed diagnostic history survives restart
    When a measured diagnostic sync succeeds
    And the diagnostic installation restarts
    Then its completed diagnostic summary is still available

  Scenario: History storage failure cannot fail or repeat a successful sync
    When diagnostic history storage stops accepting writes
    And a measured diagnostic sync succeeds
    Then the diagnostic folder still records sync success
    And diagnostic persistence is reported unavailable without leaking its error

  Scenario: The latest twenty summaries do not evict earlier healthy runs
    When 25 more diagnostic syncs succeed
    Then the latest 20 summaries are a page and older summaries remain available

  Scenario: Failed summaries outlast healthy summaries without continued activity
    When a diagnostic cloud copy fails with exit code 4
    And 8 days pass without diagnostic activity
    Then only the failed diagnostic summary remains visible
    When 23 days pass without diagnostic activity
    Then the expired diagnostic summary is no longer visible
