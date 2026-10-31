@docs @F_COVERAGE
Feature: Audit evidence without inventing delivered semantic capabilities
  @S_INVENTORY
  Scenario: Complete planned inventory is not an executed test count
    When the approved semantic manifest is expanded
    Then there are 11197 planned keys and no enabled semantic products

  @S_NEGATIVE
  Scenario Outline: Deliberately broken evidence cannot authorize exposure
    When the audit control is corrupted with "<probe>"
    Then the coverage auditor rejects it for "<reason>"
    Examples:
      | probe                | reason                 |
      | successOnly          | missing evidence       |
      | enabledPlanned       | planned delivery       |
      | lostReply            | missing evidence       |
      | finalAuthGate        | missing evidence       |
      | validation           | missing evidence       |
      | invariant            | missing evidence       |
      | missingExample       | missing example        |
      | missingFixture       | fixture                |
      | unregistered         | unregistered variant   |
      | phantom              | phantom scenario       |
      | duplicate            | duplicate caseId       |
      | wrongMode            | requested mode         |
      | wrongDriver          | driver                 |
      | guardAsSuccess       | guard                  |
      | missingMode          | native mode binding    |
      | refusalN             | refusal cannot close N |
      | duplicateNameRefusal | refusal cannot close N |
      | uniqueName           | duplicate-name facts   |
      | stale                | stale result           |
      | externalUnit         | external evidence      |
      | fixtureTamper        | fixture digest         |

  @S_STRUCTURE
  Scenario Outline: Disabled inventory still requires resolved structural references
    When the manifest structure is damaged with "<probe>"
    Then inventory validation rejects it for "<reason>"
    Examples:
      | probe            | reason                              |
      | crossTypo        | unresolved cross-operation          |
      | crossDeleted     | orphan outcome override             |
      | crossEmpty       | empty/missing selector              |
      | stagedTypo       | unresolved staged variant           |
      | stagedDeleted    | incomplete staged selector          |
      | fullListTypo     | unresolved full list base           |
      | operationTypo    | unresolved operation                |
      | rowTypo          | unresolved invariant row            |
      | missingMode      | missing applicable dependency mode  |
      | unknownOutcome   | unknown required outcome            |
      | unknownExclusion | unknown nonapplicable outcome       |
      | overlap          | required/nonapplicable overlap      |
      | validationUnknown     | unknown mode                         |
      | validationEmpty       | empty/missing mode list              |
      | validationDuplicate   | duplicate mode                      |
      | validationUnavailable | unavailable same-mode validation    |
      | fixedEmpty            | empty/missing mode list              |
      | fixedUnknown          | unknown mode                         |
      | fixedDuplicate        | duplicate mode                      |
      | fixedUnavailable      | fixed-mode control unavailable      |
      | policyEmpty           | empty/missing mode list              |
      | policyUnknown         | unknown mode                         |
      | policyDuplicate       | duplicate mode                      |
      | policyIllegal         | illegal mode                         |
      | variantEmpty          | empty/missing mode list              |
      | variantUnknown        | unknown mode                         |
      | variantIllegal        | illegal mode                         |
      | variantDuplicate      | duplicate mode                      |
      | variantMapEmpty       | empty/missing mode list              |
      | nonwriterUnavailable  | fixed-mode nonwriter route unavailable |
      | controlMissing        | missing same-mode route/control     |

  @S_CONTROL
  Scenario: Complete synthetic audit evidence is accepted without enabling a product
    When the independent audit control is checked
    Then its evidence join succeeds without changing the product registry

  @S_WEIGHT
  Scenario Outline: Shared weighted-font values obey the same finite domain in each supported context
    When the "<context>" font fixture uses weight "<weight>"
    Then the wire validation is "<result>"
    Examples:
      | context | weight   | result  |
      | text    | default  | valid   |
      | text    | 100      | valid   |
      | text    | 400      | valid   |
      | text    | 900      | valid   |
      | text    | zero     | invalid |
      | text    | offStep  | invalid |
      | text    | tooHigh  | invalid |
      | text    | fraction | invalid |
      | text    | string   | invalid |
      | named   | default  | valid   |
      | named   | 100      | valid   |
      | named   | 400      | valid   |
      | named   | 900      | valid   |
      | named   | zero     | invalid |
      | named   | offStep  | invalid |
      | named   | tooHigh  | invalid |
      | named   | fraction | invalid |
      | named   | string   | invalid |

  @S_WIRE
  Scenario Outline: Request-specific wire contracts fail closed
    When the wire fixture "<fixture>" is validated
    Then the wire validation is "<result>"
    Examples:
      | fixture                 | result |
      | namedBorderComplete     | valid  |
      | namedBorderIncomplete   | invalid|
      | weightedFontValid       | valid  |
      | weightedFontEmpty       | invalid|
      | dateEmptyLocation       | invalid|
      | unknownClearAll         | invalid|
      | clearAllNonempty        | invalid|
      | setMaskMismatch         | invalid|
      | bold                    | valid  |
      | boldString              | invalid|
      | namedStyle              | valid  |
      | namedStyleMissingMasks  | invalid|
      | namedStyleClear         | valid  |
      | namedStyleImplicitClear | invalid|
      | pageSize                | valid  |
      | documentSize            | invalid|
      | dimensionString         | invalid|
      | dimensionZero           | invalid|
      | dimensionUnit           | invalid|
      | nestedPath              | invalid|
      | tableWidth              | valid  |
      | columnWidth             | invalid|
      | outputHeader            | invalid|
      | outputSectionWidth      | invalid|
      | date                    | valid  |
      | outputDate              | invalid|
      | outputEnum              | invalid|
      | border                  | valid  |
      | partialBorder           | invalid|
      | partialBorderMask       | invalid|
      | resetBold               | valid  |
      | undeclaredReset         | invalid|
      | wildcard                | invalid|
      | rootMask                | invalid|
      | unmaskedValue           | invalid|
      | unsupportedValidator    | invalid|
      | arrayType               | invalid|
