@core
Feature: Read across connected Google Calendars
  Background:
    Given an empty single-user Calendar installation
    And I connected subject "subject-a" as "alice@example.com" with refresh token "one"
    And I connected subject "subject-b" as "bob@example.com" with refresh token "two"

  Scenario: List calendars preserves partial successes
    Given Google lists calendars "primary,team" for "alice@example.com"
    And calendar discovery fails for "bob@example.com" with an authentication error
    When I call "gcal_list_calendars" with:
      """json
      {}
      """
    Then the result includes calendars "primary,team" for "alice@example.com"
    And the result reports "reauthentication_required" for "bob@example.com"

  Scenario: Explicit event reads never choose an account or calendar
    When I call "gcal_get_event" with:
      """json
      {"account":"nobody@example.com","calendarId":"team","eventId":"event-1"}
      """
    Then the call fails with "Unknown Google account"
    And Google received no Calendar requests

  Scenario: Event lists paginate with a bounded limit and expand recurring events
    Given Google returns event pages "first,second|third" for "alice@example.com" on "team"
    When I call "gcal_list_events" with:
      """json
      {"account":"alice@example.com","calendarId":"team","timeMin":"2026-01-01T00:00:00Z","timeMax":"2026-02-01T00:00:00Z","maxResults":3}
      """
    Then the result has events "first,second,third"
    And Google received singleEvents true and orderBy "startTime"

  Scenario: Search defaults to selected and primary calendars across accounts
    Given Google lists primary "main", selected "team", and unselected "hidden" for "alice@example.com"
    And Google lists primary "home" for "bob@example.com"
    When I call "gcal_search_events" with:
      """json
      {"timeMin":"2026-01-01T00:00:00Z","timeMax":"2026-02-01T00:00:00Z"}
      """
    Then Google searched calendar IDs "main,team,home"

  Scenario: Explicit search targets override calendar selection
    Given Google lists primary "main", selected "team", and unselected "hidden" for "alice@example.com"
    When I call "gcal_search_events" with:
      """json
      {"timeMin":"2026-01-01T00:00:00Z","timeMax":"2026-02-01T00:00:00Z","targets":[{"account":"alice@example.com","calendarId":"hidden"}]}
      """
    Then Google searched calendar IDs "hidden"

  Scenario: Search merges recurring event copies and attributes their sources
    Given both accounts can access the shared calendar "team"
    And the same occurrence "uid-1" appears in each account's "team" calendar
    When I call "gcal_search_events" with:
      """json
      {"timeMin":"2026-01-01T00:00:00Z","timeMax":"2026-02-01T00:00:00Z"}
      """
    Then the result has one event with two sources

  Scenario: Search retains results when another calendar fails
    Given Google lists primary "main" and selected "broken" for "alice@example.com"
    And Google has event "found" on "alice@example.com" calendar "main"
    And event listing fails for "alice@example.com" calendar "broken"
    When I call "gcal_search_events" with:
      """json
      {"timeMin":"2026-01-01T00:00:00Z","timeMax":"2026-02-01T00:00:00Z"}
      """
    Then the result has events "found"
    And the result reports "event_list_failed" for "alice@example.com"

  Scenario: Free/busy retains the selected calendar IDs
    When I call "gcal_free_busy" with:
      """json
      {"account":"alice@example.com","timeMin":"2026-01-01T09:00:00Z","timeMax":"2026-01-01T17:00:00Z","calendarIds":["team","home"]}
      """
    Then Google received one free/busy query for "team,home"
