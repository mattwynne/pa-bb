Feature: Show folder selection availability before offering an action
  The folder browser keeps navigation available, but does not offer duplicate
  or overlapping selections that the sync service will reject.

  Scenario Outline: An existing selection reserves itself, ancestors and children
    Given the picker has a "ready" selection for Test Vault
    When the picker displays the "<folder>" folder
    Then its selection label is "<label>"

    Examples:
      | folder     | label                      |
      | Test Vault | Selected                   |
      | Notes      | Contains a selected folder |
      | Child      | Inside a selected folder   |

  Scenario Outline: Paused, running and failed selections still reserve the folder
    Given the picker has a "<phase>" selection for Test Vault
    When the picker displays the "Test Vault" folder
    Then its selection label is "Selected"

    Examples:
      | phase   |
      | paused  |
      | running |
      | failed  |

  Scenario Outline: Retained previous mirrors do not reserve a folder
    Given the picker has a "retained" selection for Test Vault
    When the picker displays the "<folder>" folder
    Then the picker offers selection

    Examples:
      | folder     |
      | Test Vault |
      | Notes      |
      | Child      |

  Scenario: An unrelated sibling remains selectable
    Given the picker has a "ready" selection for Test Vault
    When the picker displays the "Other Vault" folder
    Then the picker offers selection
