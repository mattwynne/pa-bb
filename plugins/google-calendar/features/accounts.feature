@core
Feature: Configure and manage Google Calendar accounts
  Background:
    Given an empty single-user Calendar installation

  Scenario: A Web authorization starts with short-lived state, PKCE, and Calendar-only scopes
    Given a Web OAuth client is configured
    When I begin connecting an account
    Then the authorization URL contains the five required Calendar identity and API scopes
    And the authorization has a PKCE S256 challenge and one-use state
    And the authorization does not expose the client secret

  Scenario: Two verified Google accounts coexist and expose all of their calendars
    Given a Web OAuth client is configured
    When I connect subject "subject-a" as "alice@example.com"
    And I connect subject "subject-b" as "bob@example.com"
    And Google lists calendars "primary,team,family" for "alice@example.com"
    Then the connected accounts are "alice@example.com,bob@example.com"
    And calendar discovery includes "primary,team,family" for "alice@example.com"

  Scenario Outline: Invalid callbacks do not install an account
    Given a Web OAuth client is configured
    And I begin connecting an account
    When the callback has "<problem>"
    Then the callback fails safely
    And no account was saved
    Examples:
      | problem                 |
      | missing state           |
      | mismatched state        |
      | expired state           |
      | missing code            |
      | Google cancellation     |
      | missing refresh token   |
      | unverified email        |
      | missing subject         |
      | missing required scopes |

  Scenario: A replayed callback is refused
    Given a Web OAuth client is configured
    And I begin connecting an account
    When the callback succeeds for subject "subject-a" as "alice@example.com"
    And the same callback is replayed
    Then the replay fails safely
    And the connected accounts are "alice@example.com"

  Scenario: A duplicate identity cannot replace an existing refresh token
    Given I connected subject "subject-a" as "alice@example.com" with refresh token "original"
    And a Web OAuth client is configured
    And I begin connecting an account
    When the callback succeeds for subject "subject-a" as "renamed@example.com" with refresh token "replacement"
    Then the callback fails safely
    And subject "subject-a" still has refresh token "original"

  Scenario: Removing an account does not remove another or revoke its Google grant
    Given I connected subject "subject-a" as "alice@example.com" with refresh token "one"
    And I connected subject "subject-b" as "bob@example.com" with refresh token "two"
    When I remove the account with subject "subject-a"
    Then the connected accounts are "bob@example.com"
    And Google received no revocation request

  Scenario: Late token refresh cannot resurrect a removed account
    Given I connected subject "subject-a" as "alice@example.com" with refresh token "one"
    When I remove the account with subject "subject-a"
    And a refresh based on token "one" finishes for subject "subject-a"
    Then no account was saved
