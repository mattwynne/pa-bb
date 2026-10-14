Feature: Stock bisync owns two-way file safety without whole-folder backups
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
    And sync used only native bisync without separate recovery capture

  Scenario: Conflicting edits keep both versions
    When I change the cloud note to "a cloud version of the note"
    And I change the local cloud note to "a different BB version of the note"
    And the cloud adapter synchronizes the mirror
    Then both sides keep both conflicting versions
    And sync used only native bisync without separate recovery capture

  Scenario: A local deletion propagates without an independent recovery copy
    When I delete the local cloud note
    And the cloud adapter synchronizes the mirror
    Then the cloud note is deleted
    And no whole-folder recovery store was created

  Scenario: A rename propagates as creation and deletion
    When I rename the cloud note
    And the cloud adapter synchronizes the mirror
    Then the local folder contains the renamed note instead of the old name
    And no whole-folder recovery store was created

  Scenario: Native maximum-deletion checks still protect the other side
    When I delete four of the five cloud notes
    Then native deletion checks refuse to delete the local notes
    And sync used only native bisync without separate recovery capture
