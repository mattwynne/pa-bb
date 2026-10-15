Feature: Whole-vault Obsidian tools
  Connecting a vault immediately connects all Markdown notes for reading and editing.
  No permissions, read-only switches, previews or approvals are involved.

  Scenario: Installation alone connects no vault
    Given two generated iCloud vaults
    When I search all connected vaults for "Launch"
    Then no source notes are exposed

  Scenario: Identical names remain attributed to different vaults
    Given two generated iCloud vaults
    And both vaults are connected
    When I search all connected vaults for "Launch"
    Then the results identify vaults "one" and "two"

  Scenario: Read, follow a link and list unfinished tasks
    Given two generated iCloud vaults
    And both vaults are connected
    When I read "Launch.md" in vault "one"
    Then the complete note version and source lines are returned
    And I can follow "Other" within vault "one"
    And one unfinished task is returned for "Launch.md"

  Scenario: Append without a confirmation and preserve unrelated bytes
    Given two generated iCloud vaults
    And both vaults are connected
    When I read "Launch.md" in vault "one"
    And I append a decision to that version
    Then the original bytes precede the decision
    And the save says saved locally pending sync

  Scenario: An intervening change cannot be lost
    Given two generated iCloud vaults
    And both vaults are connected
    When I read "Launch.md" in vault "one"
    And the source changes before I append
    Then the stale edit is rejected without replacing the change

  Scenario: Removing a vault revokes note and receipt exposure without deleting notes
    Given two generated iCloud vaults
    And both vaults are connected
    When I remove vault "one"
    Then vault "one" cannot be read or inspected
    And the generated source notes still exist

  Scenario: Restart preserves connected mirror identities
    Given two generated iCloud vaults
    And both vaults are connected
    When the plugin restarts
    Then both vaults remain connected

  Scenario: A failed vault does not become an empty successful search
    Given two generated iCloud vaults
    And both vaults are connected
    When vault "one" fails
    And I search all connected vaults for "Launch"
    Then vault "two" has results with a partial failure for "one"
