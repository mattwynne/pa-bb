Feature: Other calendars reflect my commitments without sharing their details
  I want my work calendar to show when I am busy elsewhere
  so colleagues can find a time without seeing my personal appointments.

  # First slice: one-way busy-time copying, not full event synchronization.
  # Open question before implementation: how far ahead should busy time be copied?
  # Out of scope: changing organizer RSVPs, Cal.com settings or old manual blocks.

  Background:
    Given my timezone is "Europe/London"
    And I sync busy time from "Personal" to "Work"

  Rule: Only actual commitments make me busy

    Scenario: An accepted appointment hides its details from colleagues
      Given I have accepted "Dentist" in Personal on 7 May 2030 from 10:00 to 11:00
      When my calendars synchronize
      Then Work should contain a private event called "Busy" from 10:00 to 11:00 on 7 May 2030
      And it should block that time for bookings
      And it should contain no original title, description, location, guests or meeting link

    Scenario Outline: An invitation I have not accepted leaves the time free
      Given Personal contains a busy invitation for 7 May 2030 from 10:00 to 11:00
      And my response is <response>
      When my calendars synchronize
      Then no Busy block should be copied to Work for that invitation

      Examples:
        | response   |
        | unanswered |
        | tentative  |
        | declined   |

    Scenario Outline: My own appointments do not need an invitation response
      Given I created "School pickup" in Personal on 7 May 2030 from 15:00 to 15:30
      And it has no guests and is marked <availability>
      When my calendars synchronize
      Then Work should contain <count> Busy blocks for School pickup

      Examples:
        | availability | count |
        | busy         | 1     |
        | free         | 0     |

  Rule: Copied busy time follows the original commitment

    Scenario: An appointment moves an hour later
      Given Dentist in Personal has a Busy block in Work for 7 May 2030 from 10:00 to 11:00
      When I move Dentist to 11:00 to 12:00 in Personal
      And my calendars synchronize
      Then its only Busy block in Work should cover 11:00 to 12:00 on 7 May 2030
      And Dentist in Personal should remain unchanged by synchronization

    Scenario Outline: A commitment no longer needs its Busy block
      Given Dentist in Personal has a Busy block in Work
      And Work also contains a meeting I created called "Planning"
      When <change>
      And my calendars synchronize
      Then the Busy block for Dentist should be removed
      And Planning should remain unchanged

      Examples:
        | change                                      |
        | Dentist is cancelled in Personal            |
        | Dentist is deleted from Personal             |
        | I decline Dentist in Personal                |
        | I mark Dentist as free in Personal           |

    Scenario: Declining one stand-up does not decline the whole series
      Given I have accepted a weekly stand-up in Personal from 12:00 to 12:30
      And Work has Busy blocks for its occurrences on 7 and 14 May 2030
      When I decline only the stand-up on 14 May in Personal
      And my calendars synchronize
      Then the stand-up Busy block on 14 May should be removed
      And the stand-up Busy block on 7 May should remain

  Rule: Copies never become new commitments

    Scenario: A reflected Busy block does not multiply
      Given Dentist in Personal already has one Busy block in Work
      And that copied block also appears in a calendar connected as a source
      When my calendars synchronize again
      Then Dentist should still have exactly one Busy block in Work
      And no Busy block should be created from the copied block

  Rule: Failure to read a calendar is not evidence that I am free

    Scenario: Personal is temporarily unavailable
      Given Dentist in Personal has a Busy block in Work
      When Personal cannot be read during synchronization
      Then the Busy block for Dentist should remain unchanged
      And I should be told that Personal could not be synchronized
