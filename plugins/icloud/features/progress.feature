Feature: Honest folder progress without exposing provider data
  Scenario: Initial preparation reports progress before its first success
    Given a selected progress test folder before initial preparation
    When initial progress preparation is waiting to finish
    And its provider reports a quarter of the transfer with extra private fields
    Then initial preparation has progress but no successful timestamp
    When the progress test sync finishes
    Then the successful timestamp advances and progress disappears

  Scenario Outline: Running progress names each stage without inventing a percentage
    Given a progress test folder with a successful sync
    When another progress test sync is waiting to finish
    And its provider reports the "<stage>" stage with unknown totals
    Then the running folder reports "<stage>" activity without a percentage
    And its successful timestamp has not changed
    And its progress is not stored in the repository
    Examples:
      | stage            |
      | checking         |
      | backing_up_cloud |
      | backing_up_local |
      | saving_recovery  |
      | transferring     |
      | verifying        |

  Scenario: Measured transfer progress excludes private provider fields
    Given a progress test folder with a successful sync
    When another progress test sync is waiting to finish
    And its provider reports a quarter of the transfer with extra private fields
    Then the running folder reports 25 percent transfer progress
    And no private progress field is exposed
    And its successful timestamp has not changed

  Scenario: All transfers are not the same as a successful sync
    Given a progress test folder with a successful sync
    When another progress test sync is waiting to finish
    And its provider reports that all transfers finished
    Then the folder is still running with its previous successful timestamp
    When the progress test sync finishes
    Then the successful timestamp advances and progress disappears
    And late provider progress is ignored

  Scenario: Failed runs clear progress and preserve the successful timestamp
    Given a progress test folder with a successful sync
    When another progress test sync is waiting to finish
    And its provider reports a quarter of the transfer with extra private fields
    And the progress test provider fails
    Then the progress test folder needs recovery with no progress
    And its successful timestamp has not changed

  Scenario: Restart cannot restore stale progress
    Given a progress test folder with a successful sync
    When another progress test sync is waiting to finish
    And its provider reports a quarter of the transfer with extra private fields
    And the progress test installation restarts
    Then the progress test folder needs recovery with no progress
    And its successful timestamp has not changed
