Feature: Incremental recovery without weakening two-way file safety
  Background:
    Given two disposable filesystem folders and stock rclone
    And an initialized two-way mirror with five notes
    And an unchanged indexed recovery copy

  Scenario: A no-change sync does not download unchanged recovery file bodies
    When the cloud adapter synchronizes the mirror
    Then no cloud file bodies were downloaded for recovery
    And recovery copies still contain the original note

  Scenario: A changed cloud file is the only new recovery download
    When I change the cloud note to "a cloud version of the note"
    And the cloud adapter synchronizes the mirror
    Then only the changed cloud note was downloaded for recovery
    And the local cloud note contains "a cloud version of the note"
    And recovery copies still contain the original note

  Scenario: Both conflicting edits are backed up before conflict preservation
    When I change the cloud note to "a cloud version of the note"
    And I change the local cloud note to "a different BB version of the note"
    And the cloud adapter synchronizes the mirror
    Then only the changed cloud note was downloaded for recovery
    And recovery copies contain both new note versions
    And both sides keep both conflicting versions

  Scenario: Selection lists cannot treat literal filenames as comments or extra paths
    When I add cloud notes with literal comment and newline filenames
    And the cloud adapter synchronizes the mirror
    Then both unusual filenames and their contents are mirrored exactly

  Scenario: A local deletion still captures its cloud counterpart before propagation
    When I delete the local cloud note
    And the cloud adapter synchronizes the mirror
    Then only the changed cloud note was downloaded for recovery
    And the cloud note is deleted
    And recovery copies still contain the original note
