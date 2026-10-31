@docs @EXEC
Feature: Preserve legacy formatting submission evidence
  The formatting service and Google adapters use closed HTTP fixtures and real SQLite.
  Recovery reads the original operation key and never repeats a mutation.

  @FORMAT403 @restart @privacy
  Scenario: An acknowledged formatting POST is followed by a forbidden Docs read
    Given the Docs boundary will fail at "docs403"
    When formatting is applied once
    Then the formatting outcome is "uncertain" with 1 mutation
    And the acknowledgement and unresolved claim are retained
    When SQLite is closed and reopened and the same key is inspected
    Then recovery is unavailable without forgetting the acknowledgement or releasing the claim
    And diagnostics contain only the safe verification boundary

  @STAGE_EVIDENCE @restart @privacy
  Scenario Outline: Failures at different boundaries do not erase submission facts
    Given the Docs boundary will fail at "<fault>"
    When formatting is applied once
    Then the formatting outcome is "<outcome>" with <posts> mutation
    And the saved lifecycle is "<state>" with acknowledgement "<ack>" and claim "<claim>"
    When SQLite is closed and reopened and the same key is inspected
    Then the historical attempt is "<history>" and this status call attempted no mutation
    And no private fault detail escaped

    Examples:
      | fault       | outcome       | posts | state         | ack   | claim | history |
      | metadata403 | uncertain     | 1     | uncertain     | true  | held  | true    |
      | storage     | uncertain     | 1     | writing       | false | held  | unknown |
      | reject403   | rejected      | 1     | rejected      | false | free  | true    |
      | reject400   | rejected      | 1     | rejected      | false | free  | true    |
      | auth403     | not_submitted | 0     | not_submitted | false | free  | false   |
      | finalAuth403| not_submitted | 0     | not_submitted | false | free  | false   |
      | lost        | uncertain     | 1     | uncertain     | false | held  | true    |

  @FINAL_GATE @LOCAL_ONLY
  Scenario Outline: Changes visible after final asynchronous authorization prevent submission
    Given the Docs boundary will fail at "none"
    When "<kind>" pauses in final authorization and "<change>" changes
    Then the final gate submits no mutation

    Examples:
      | kind    | change  |
      | format  | policy  |
      | format  | account |
      | format  | subject |
      | format  | cancel  |
      | format  | expiry  |
      | replace | policy  |
      | replace | account |
      | replace | subject |
      | replace | cancel  |

  @FINAL_GATE @CALLBACK_AWAIT @LOCAL_ONLY
  Scenario Outline: Later callback checks observe changes during earlier local awaits
    Given the Docs boundary will fail at "none"
    When "<kind>" pauses at "<boundary>" and "<change>" changes
    Then the final gate submits no mutation

    Examples:
      | kind    | boundary | change |
      | format  | claim    | policy |
      | format  | claim    | cancel |
      | format  | claim    | expiry |
      | format  | policy   | cancel |
      | format  | policy   | expiry |
      | format  | intent   | policy |
      | replace | claim    | policy |
      | replace | claim    | cancel |
      | replace | policy   | cancel |

  @CONSENT
  Scenario Outline: Requested formatting and text deletion retain the owner-controlled policy
    Given the Docs boundary will fail at "none"
    And the approval setting is "<policy>"
    When the requested "<kind>" is applied
    Then the write verifies with <cards> owner reviews

    Examples:
      | kind    | policy | cards |
      | format  | off    | 0     |
      | format  | on     | 1     |
      | replace | off    | 0     |
      | replace | on     | 1     |
