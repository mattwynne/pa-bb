Feature: Selected iCloud folders become safe local mirrors
  Background:
    Given a new iCloud installation

  Scenario: Connection alone is not consent to sync
    When I connect my Apple account
    Then BB asks for a verification code
    When I answer the Apple challenge
    And I select the Test Vault folder
    And a minute passes
    Then no files have been synchronized
    And my folder is paused

  Scenario: First enable prepares a baseline exactly once
    Given a connected Apple account and selected Test Vault
    When I enable syncing
    And a minute passes
    Then the cloud provider prepared the mirror once
    And the cloud provider synchronized the mirror once
    And the folder has a last successful sync

  Scenario: Pause and resume preserve the baseline
    Given a syncing Test Vault
    When I pause syncing
    And a minute passes
    Then no additional files have been synchronized
    When I resume syncing
    And a minute passes
    Then the cloud provider prepared the mirror once
    And the cloud provider synchronized the mirror once

  Scenario Outline: Retryable failures preserve intent and use the next ordinary schedule
    Given a syncing Test Vault
    When the provider fails with <failure>
    And a minute passes
    Then the folder is pending an automatic retry
    And its last successful sync is unchanged
    When the provider recovers
    When another minute passes
    Then the failed run is retried once
    And the folder is ready again
    Examples:
      | failure        |
      | sync_failed    |
      | interrupted    |
      | source_changed |

  Scenario: Capacity remains an actionable stop
    Given a syncing Test Vault
    When the provider fails with capacity
    And a minute passes
    Then the folder has the capacity blocker
    When another minute passes
    Then the failed run is not retried
    When the provider recovers
    And I explicitly retry syncing
    Then the failed run is retried once
    And the folder is ready again

  Scenario Outline: Repaired host blockers allow only an explicit ordinary retry
    Given a syncing Test Vault
    When the provider fails with <failure>
    And a minute passes
    Then the folder has the <blocker> blocker
    When the provider recovers
    And another minute passes
    Then the failed run is not retried
    When I explicitly retry syncing
    Then the failed run is retried once
    And the folder is ready again
    Examples:
      | failure          | blocker       |
      | configuration    | configuration |
      | invalid_selection | configuration |

  Scenario: Pause cancels retry and Resume uses the ordinary safe path
    Given a syncing Test Vault
    When the provider fails with sync_failed
    And a minute passes
    Then the folder is pending an automatic retry
    When I pause syncing
    And the provider recovers
    And a minute passes
    Then the failed run is not retried
    When I resume syncing
    Then the failed run is retried once
    And the folder is ready again

  Scenario Outline: Actionable failures do not enter the scheduled retry loop
    Given a syncing Test Vault
    When the provider fails with <failure>
    And a minute passes
    Then the folder has the <blocker> blocker
    When the provider recovers
    And another minute passes
    Then the failed run is not retried
    Examples:
      | failure          | blocker       |
      | recovery_required | rebuild      |
      | configuration    | configuration |

  Scenario: Restart after an interrupted initialized run retries normally
    Given a syncing Test Vault
    When BB restarts with a running mirror recorded
    Then the folder is pending an automatic retry
    And a minute passes
    Then the failed run is retried once

  Scenario: Disconnect keeps local mirrors and does not resume on reconnect
    Given a syncing Test Vault
    When I disconnect Apple
    Then my folder is paused
    And the local mirror remains available
    When I connect my Apple account
    And I answer the Apple challenge
    And a minute passes
    Then no additional files have been synchronized

  Scenario: Repeated schedule ticks never overlap
    Given a syncing Test Vault
    When a synchronization is still running at the next tick
    Then only one synchronization is in flight

  Scenario: Nested folder selections are rejected
    Given a connected Apple account and selected Test Vault
    When I select a child of Test Vault
    Then the selection is rejected

  Scenario: Reconnect preserves enabled intent and resumes only that folder
    Given a syncing Test Vault
    When the provider fails with authentication
    And a minute passes
    Then the folder has the reconnect blocker
    And I connect my Apple account
    And I answer the Apple challenge
    And the provider recovers
    And a minute passes
    Then the failed run is not retried
    When I resume syncing
    Then the failed run is retried once
    And the folder is ready again

  Scenario: Explicit recovery creates a fresh mirror and keeps unsent local edits separate
    Given a syncing Test Vault
    When the provider fails with recovery_required
    And a minute passes
    And I request a fresh mirror from iCloud
    Then the previous mirror is retained without automatic repair
    And a different local mirror is initialized

  Scenario: Independent folder failures do not report another folder as failed
    Given a connected Apple account and selected Test Vault
    When I also select Other Vault
    And I enable syncing
    And the provider fails with capacity
    And a minute passes
    Then Other Vault remains paused
