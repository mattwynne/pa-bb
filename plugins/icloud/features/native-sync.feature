Feature: Native sync avoids wrapper listings and preserves legacy recovery files
  Background:
    Given two disposable filesystem folders and stock rclone
    And an initialized two-way mirror with five notes

  Scenario: A no-change sync needs no separate recovery capture
    When the cloud adapter synchronizes the mirror
    Then sync used only native bisync without separate recovery capture
    And no whole-folder recovery store was created

  Scenario: Cloud edits synchronize without a separate backup download
    When I change the cloud note to "a cloud version of the note"
    And the cloud adapter synchronizes the mirror
    Then the local cloud note contains "a cloud version of the note"
    And sync used only native bisync without separate recovery capture

  Scenario: Simultaneous edits use native conflict preservation
    When I change the cloud note to "a cloud version of the note"
    And I change the local cloud note to "a different BB version of the note"
    And the cloud adapter synchronizes the mirror
    Then both sides keep both conflicting versions
    And no whole-folder recovery store was created

  Scenario: Native sync preserves literal comment and newline filenames
    When I add cloud notes with literal comment and newline filenames
    And the cloud adapter synchronizes the mirror
    Then both unusual filenames and their contents are mirrored exactly
    And sync used only native bisync without separate recovery capture

  Scenario: Legacy recovery data is preserved but is not a sync precondition
    Given an opaque legacy recovery archive
    When I change the cloud note to "new cloud version"
    And the cloud adapter synchronizes the mirror
    Then the local cloud note contains "new cloud version"
    And the legacy recovery archive is unchanged
    And sync used only native bisync without separate recovery capture
