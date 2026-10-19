Feature: Read-only Google Calendar release discovery
  Scenario: A real installed revision matches the baseline
    Given Google Calendar is installed at the published baseline
    When I check PA updates
    Then the release result is "current"
    And no installation or checkout write is requested

  Scenario: Local work does not disappear when the feed fails
    Given Google Calendar is installed at the published baseline
    And a successful check has been saved
    And the release feed is now unavailable
    And relevant local files have changed
    When I check PA updates
    Then the last release information is stale
    And the local-work result is "local_changes"
    And no installation or checkout write is requested

  Scenario: Missing mapping does not prevent release discovery
    Given Google Calendar is installed at the published baseline
    And a newer Calendar release is published
    And no development checkout is configured
    When I check PA updates
    Then the release result is "available"
    And the local-work result is "not_assessed"
    And no installation or checkout write is requested

  Scenario: Calendar is not installed
    Given Google Calendar is not installed
    When I check PA updates
    Then the release result is "no_plugin"
    And no installation or checkout write is requested
