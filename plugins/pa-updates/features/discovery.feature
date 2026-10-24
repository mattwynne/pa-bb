Feature: Git-first PA development
  Try server changes before sharing them, and see differences from origin.

  Scenario: Try local code without publishing it
    Given a local-path plugin with unapplied edits
    When I apply the local changes
    Then that working code is applied without pulling or updating runtimes

  Scenario: Pushed code is not necessarily running
    Given the working copy and origin agree but an older build was applied
    Then the plugin is not reported up to date

  Scenario: Incoming code need not bump a package version
    Given origin offers different plugin contents with the same version
    When I update PA
    Then those contents are applied with that same version

  Scenario: Both sides changed
    Given local and origin changes need Git review
    When I update PA
    Then local work is kept without an empty successful update
