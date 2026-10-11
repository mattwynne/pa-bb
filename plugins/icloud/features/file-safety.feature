Feature: The stock cloud adapter preserves file changes and recovery copies
  # Optional real-binary suite. Set RCLONE_TEST_BINARY to stock v1.75.2.
  # Uses an alias to generated local test data; never connects to Apple.
  Background:
    Given two disposable filesystem folders and stock rclone
    And an initialized two-way mirror with five notes

  Scenario: Edits travel in both directions
    When I change the cloud note to "edited on the phone"
    And I add a local note containing "edited through BB"
    And the cloud adapter synchronizes the mirror
    Then the local cloud note contains "edited on the phone"
    And the cloud local note contains "edited through BB"

  Scenario: Conflicting edits keep both versions
    When I change the cloud note to "a cloud version of the note"
    And I change the local cloud note to "a different BB version of the note"
    And the cloud adapter synchronizes the mirror
    Then both sides keep both conflicting versions

  Scenario: A local deletion propagates but remains recoverable
    When I delete the local cloud note
    And the cloud adapter synchronizes the mirror
    Then the cloud note is deleted
    And recovery copies still contain the original note

  Scenario: A rename propagates as creation and deletion
    When I rename the cloud note
    And the cloud adapter synchronizes the mirror
    Then the local folder contains the renamed note instead of the old name
    And recovery copies still contain the original note

  Scenario: Backup capacity blocks provider writes
    When recovery capacity is exhausted
    Then synchronization is rejected before the cloud note changes
