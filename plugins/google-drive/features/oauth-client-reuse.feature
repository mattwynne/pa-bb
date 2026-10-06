@integration
Feature: Reuse a Google Web OAuth client across independent BB plugins
  The owner may configure Calendar or Drive first without entering the same
  client ID and secret twice. Copying credentials must not copy account grants.

  Scenario Outline: Either plugin can be configured second without copying account tokens
    Given <source> has a configured Google Web OAuth client
    And <destination> has no configured client or accounts
    And <destination> presents its HTTPS redirect URI for registration with that Web client
    When the owner chooses to copy the client from <source> to <destination>
    Then <destination> is configured with its own stored copy of that client
    And <destination> still has no connected accounts
    And authorization for <destination> requests only its own scopes
    And neither the browser result nor plugin logs contain the client secret
    When <source> is removed
    Then <destination> remains configured after reload

    Examples:
      | source   | destination |
      | Calendar | Drive       |
      | Drive    | Calendar    |

  Scenario Outline: Only the named destination plugin may request a configured client's secret
    Given <source> has a configured Google Web OAuth client
    When a <caller> requests <source>'s client credentials
    Then the request is denied without exposing the secret

    Examples:
      | source   | caller              |
      | Calendar | browser or CLI      |
      | Calendar | unrelated plugin    |
      | Drive    | browser or CLI      |
      | Drive    | unrelated plugin    |

  Scenario Outline: An absent or unconfigured source cannot silently configure the destination
    Given <source> is <condition>
    And <destination> has no configured client or accounts
    When the owner chooses to copy the client from <source> to <destination>
    Then the import fails without changing <destination>'s client settings

    Examples:
      | source   | condition    | destination |
      | Calendar | absent       | Drive       |
      | Calendar | unconfigured | Drive       |
      | Drive    | absent       | Calendar    |
      | Drive    | unconfigured | Calendar    |

  Scenario Outline: Copying a client cannot replace one used by connected accounts
    Given <source> has a configured Google Web OAuth client
    And <destination> has a connected Google account
    When the owner chooses to copy the client from <source> to <destination>
    Then the import is refused before requesting <source>'s secret
    And <destination>'s connected account remains unchanged

    Examples:
      | source   | destination |
      | Calendar | Drive       |
      | Drive    | Calendar    |
