@docs @EXEC
Feature: Preserve legacy formatting submission evidence
  The formatting service and Google adapters use closed HTTP fixtures and real SQLite.
  Recovery reads the original operation key and never repeats a mutation.

  @FORMAT403 @restart @privacy
  Scenario: An acknowledged formatting POST is followed by a forbidden Docs read [S00.format.docs403]
    Given the Docs boundary will fail at "docs403"
    When formatting is applied once
    Then the formatting outcome is "uncertain" with 1 mutation
    And the acknowledgement and unresolved claim are retained
    When SQLite is closed and reopened and the same key is inspected
    Then recovery is unavailable without forgetting the acknowledgement or releasing the claim
    And diagnostics contain only the safe verification boundary

  @STAGE_EVIDENCE @restart @privacy
  Scenario Outline: Failures at different boundaries do not erase submission facts [<caseId>]
    Given the Docs boundary will fail at "<fault>"
    When formatting is applied once
    Then the formatting outcome is "<outcome>" with <posts> mutation
    And the saved lifecycle is "<state>" with acknowledgement "<ack>" and claim "<claim>"
    When SQLite is closed and reopened and the same key is inspected
    Then the historical attempt is "<history>" and this status call attempted no mutation
    And no private fault detail escaped

    Examples:
      | fault       | outcome       | posts | state         | ack   | claim | history | caseId                  |
      | metadata403 | uncertain     | 1     | uncertain     | true  | held  | true    | S00.format.metadata403  |
      | storage     | uncertain     | 1     | writing       | false | held  | unknown | S00.format.storage      |
      | reject403   | rejected      | 1     | rejected      | false | free  | true    | S00.format.reject403    |
      | reject400   | rejected      | 1     | rejected      | false | free  | true    | S00.format.reject400    |
      | auth403     | not_submitted | 0     | not_submitted | false | free  | false   | S00.format.auth403      |
      | finalAuth403| not_submitted | 0     | not_submitted | false | free  | false   | S00.format.finalAuth403 |
      | lost        | uncertain     | 1     | uncertain     | false | held  | true    | S00.format.lost         |

  @FINAL_GATE @LOCAL_ONLY
  Scenario Outline: Changes visible after final asynchronous authorization prevent submission [<caseId>]
    Given the Docs boundary will fail at "none"
    When "<kind>" pauses in final authorization and "<change>" changes
    Then the final gate submits no mutation

    Examples:
      | kind    | change  | caseId                   |
      | format  | policy  | S00.format.auth.policy   |
      | format  | account | S00.format.auth.account  |
      | format  | subject | S00.format.auth.subject  |
      | format  | cancel  | S00.format.auth.cancel   |
      | format  | expiry  | S00.format.auth.expiry   |
      | replace | policy  | S00.replace.auth.policy  |
      | replace | account | S00.replace.auth.account |
      | replace | subject | S00.replace.auth.subject |
      | replace | cancel  | S00.replace.auth.cancel  |

  @FINAL_GATE @CALLBACK_AWAIT @LOCAL_ONLY
  Scenario Outline: Later callback checks observe changes during earlier local awaits [<caseId>]
    Given the Docs boundary will fail at "none"
    When "<kind>" pauses at "<boundary>" and "<change>" changes
    Then the final gate submits no mutation

    Examples:
      | kind    | boundary | change | caseId                    |
      | format  | claim    | policy | S00.format.claim.policy   |
      | format  | claim    | cancel | S00.format.claim.cancel   |
      | format  | claim    | expiry | S00.format.claim.expiry   |
      | format  | policy   | cancel | S00.format.policy.cancel  |
      | format  | policy   | expiry | S00.format.policy.expiry  |
      | format  | intent   | policy | S00.format.intent.policy  |
      | replace | claim    | policy | S00.replace.claim.policy  |
      | replace | claim    | cancel | S00.replace.claim.cancel  |
      | replace | policy   | cancel | S00.replace.policy.cancel |

  @CONSENT
  Scenario Outline: Requested formatting and text deletion retain the owner-controlled policy [<caseId>]
    Given the Docs boundary will fail at "none"
    And the approval setting is "<policy>"
    When the requested "<kind>" is applied
    Then the write verifies with <cards> owner reviews

    Examples:
      | kind    | policy | cards | caseId                  |
      | format  | off    | 0     | S00.format.consent.off  |
      | format  | on     | 1     | S00.format.consent.on   |
      | replace | off    | 0     | S00.replace.consent.off |
      | replace | on     | 1     | S00.replace.consent.on  |
