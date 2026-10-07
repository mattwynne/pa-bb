@core
Feature: Calendar writes need explicit approval and predictable notifications
  Background:
    Given an empty single-user Calendar installation
    And I connected subject "subject-a" as "alice@example.com" with refresh token "one"

  Scenario Outline: Rejected approval sends no Google mutation
    Given the owner denies the next Calendar change
    When I call "<tool>" with:
      """json
      <arguments>
      """
    Then the call fails with "Calendar change was not approved"
    And Google received no Calendar writes
    Examples:
      | tool              | arguments                                                                                                                                |
      | gcal_create_event | {"account":"alice@example.com","calendarId":"team","summary":"New","start":"2026-10-01","allDay":true}                      |
      | gcal_update_event | {"account":"alice@example.com","calendarId":"team","eventId":"e1","summary":"Renamed"}                                      |
      | gcal_delete_event | {"account":"alice@example.com","calendarId":"team","eventId":"e1"}                                                           |

  Scenario: All-day creation uses an exclusive next-day end without attendee notifications
    When I call "gcal_create_event" with:
      """json
      {"account":"alice@example.com","calendarId":"team","summary":"Away","start":"2026-10-01","allDay":true,"attendees":["guest@example.com"]}
      """
    Then Google inserted an event ending on "2026-10-02" with sendUpdates "none"

  Scenario: Timed creation requires an end before approval or a write
    When I call "gcal_create_event" with:
      """json
      {"account":"alice@example.com","calendarId":"team","summary":"Meeting","start":"2026-10-01T09:00:00Z"}
      """
    Then the call fails with "An end datetime is required for non-all-day events"
    And Google received no Calendar writes

  Scenario: A partial reschedule is refused before approval or a write
    When I call "gcal_update_event" with:
      """json
      {"account":"alice@example.com","calendarId":"team","eventId":"e1","start":"2026-10-01T09:00:00Z"}
      """
    Then the call fails with "Rescheduling requires both start and end"
    And Google received no Calendar writes

  Scenario: Move and patch sends attendee updates only with the final change
    Given the owner chooses to notify attendees
    When I call "gcal_update_event" with:
      """json
      {"account":"alice@example.com","calendarId":"team","eventId":"e1","moveToCalendarId":"other","summary":"Renamed","sendUpdates":"all"}
      """
    Then Google moved the event with sendUpdates "none"
    And Google patched it in "other" with sendUpdates "all"

  Scenario Outline: Notifications stay off unless the owner chooses them, even when the agent requests updates
    When I call "<tool>" with:
      """json
      <arguments>
      """
    Then all Calendar writes used sendUpdates "none"
    Examples:
      | tool              | arguments                                                                                                                                    |
      | gcal_create_event | {"account":"alice@example.com","calendarId":"team","summary":"Away","start":"2026-10-01","allDay":true,"sendUpdates":"all"}                 |
      | gcal_update_event | {"account":"alice@example.com","calendarId":"team","eventId":"e1","summary":"Renamed","sendUpdates":"all"}                                    |
      | gcal_delete_event | {"account":"alice@example.com","calendarId":"team","eventId":"e1","sendUpdates":"all"}                                                        |

  Scenario Outline: Choosing the checkbox notifies all attendees, even when the agent requests no updates
    Given the owner chooses to notify attendees
    When I call "<tool>" with:
      """json
      <arguments>
      """
    Then all Calendar writes used sendUpdates "all"
    Examples:
      | tool              | arguments                                                                                                                                    |
      | gcal_create_event | {"account":"alice@example.com","calendarId":"team","summary":"Away","start":"2026-10-01","allDay":true,"sendUpdates":"none"}                |
      | gcal_update_event | {"account":"alice@example.com","calendarId":"team","eventId":"e1","summary":"Renamed","sendUpdates":"none"}                                   |
      | gcal_delete_event | {"account":"alice@example.com","calendarId":"team","eventId":"e1","sendUpdates":"none"}                                                       |

  Scenario: Delete defaults to no attendee notifications
    When I call "gcal_delete_event" with:
      """json
      {"account":"alice@example.com","calendarId":"team","eventId":"e1"}
      """
    Then Google deleted the event with sendUpdates "none"
