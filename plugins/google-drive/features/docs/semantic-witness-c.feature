@F_SEMANTIC_WITNESS_C
Feature: Compare bounded read witnesses without authoring authority
  Scenario Outline: Original read observations support only their exact witness contract
    Given the C read-evidence application uses scripted observations and a logical snapshot substitute
    When the independent C witness pair "<contract>" is compared
    Then only the concretely supported read witness satisfies coverage
    And neither comparison grants authoring authority or sends a mutation
    Examples:
      | contract           |
      | narrowLiteral      |
      | styleFromMetadata  |
      | broadDelivered     |
      | completePreview    |
      | generatedNode      |
      | namedStyleIndirect |
      | historyNotCurrent  |
      | siblingNotCovered  |
