@docs @F_BOUNDARY
Feature: Independent offline provider and asset contracts
  @S_APPLIED_LOSS
  Scenario: An applied batch loses its reply without gaining acknowledgement [S01.format.appliedLost]
    Given the Docs boundary will fail at "appliedLost"
    When formatting is applied once
    Then the formatting outcome is "uncertain" with 1 mutation
    When SQLite is closed and reopened and the same key is inspected
    Then matching applied state remains an observation and the key cannot replay
    And no private fault detail escaped

  @S_WIRE_PRESERVATION
  Scenario Outline: Legacy service requests preserve independently specified content [<caseId>]
    Given the Docs boundary will fail at "none"
    When the requested "<kind>" is applied
    Then the complete independent "<kind>" after-document matches
    Examples:
      | kind    | caseId                       |
      | format  | S01.format.wirePreservation  |
      | replace | S01.replace.wirePreservation |

  @S_ASSETS
  Scenario Outline: Real asset validation uses bounded DNS and HTTPS fixtures
    When the real asset validator inspects the "<fault>" boundary
    Then the asset outcome is "<outcome>" with <dns> DNS and <https> HTTPS calls
    Examples:
      | fault    | outcome | dns | https |
      | none     | valid   | 1   | 1     |
      | private  | refused | 1   | 0     |
      | redirect | refused | 1   | 1     |
      | oversize | refused | 1   | 1     |
      | corrupt  | refused | 1   | 1     |

  @S_TEARDOWN
  Scenario Outline: Swallowed network fixture faults still fail teardown and dispose SQLite
    When a "<fault>" fixture failure is swallowed before teardown
    Then teardown rejects the recorded fault and still closes SQLite
    Examples:
      | fault          |
      | DNS            |
      | HTTPS          |
      | DNS contract   |
      | HTTPS contract |
      | HTTP contract  |

  @S_BATCH_CONTRACT
  Scenario Outline: Every malformed batch shape is journaled once before any dereference escapes
    When malformed batch "<shape>" is swallowed before teardown
    Then teardown rejects the recorded fault and still closes SQLite
    Examples:
      | shape            |
      | null             |
      | emptyObject      |
      | array            |
      | stringRoot       |
      | nullRequests     |
      | objectRequests   |
      | stringRequests   |
      | booleanRequests  |
      | emptyRequests    |
      | nullEntry        |
      | arrayEntry       |
      | booleanEntry     |
      | stringEntry      |
      | emptyEntry       |
      | unknownRequest   |
      | nullPayload      |
      | multipleRequests |

  @S_CLOSED_PORTS
  Scenario Outline: Unexpected network routes fail loudly even if application catches them
    When an unexpected "<port>" route reaches the fixture
    Then its closed-network check fails
    Examples:
      | port  |
      | HTTP  |
      | DNS   |
      | HTTPS |
