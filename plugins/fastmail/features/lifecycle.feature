Feature: Standalone Fastmail connection in BB
  Scenario: One Fastmail install coexists with Google Calendar
    Given a standalone Fastmail installation beside Google Calendar
    When Fastmail grants a mail read and a calendar mutation tool
    Then both granted Fastmail tools are selectable with provider schemas
    And Google Calendar remains independent

  Scenario: Remote callback paste-back is bound to this plugin and one state
    Given Fastmail authorization is pending
    When a callback for another plugin is pasted
    Then the callback is rejected before token exchange
    When the valid callback is consumed
    Then replay of that callback is rejected

  Scenario: Removing access removes all callable tools
    Given a standalone Fastmail installation beside Google Calendar
    When Fastmail grants a mail read and a calendar mutation tool
    And Fastmail is disconnected
    Then no cached Fastmail mutation can run
    And disabling Fastmail cannot reconnect it
    And Google Calendar remains independent
