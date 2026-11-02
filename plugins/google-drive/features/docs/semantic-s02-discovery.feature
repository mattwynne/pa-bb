@docs @bridgeExecution
Feature: Inspect kinds, recursive tabs and provenance through actual read use cases

@C001 @F_READ @S_KIND
  Scenario Outline: Actual S02 inspection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C001.nativeDoc__read.success |
      | C001.nativeDoc__read.invalid |
      | C001.nativeDoc__read.preservation |
      | C001.nativeDoc__read.bounds |
      | C001.nativeDoc__read.wrongSubject |
      | C001.markdownBlob__read.success |
      | C001.markdownBlob__read.invalid |
      | C001.markdownBlob__read.preservation |
      | C001.markdownBlob__read.bounds |
      | C001.markdownBlob__read.wrongSubject |
      | C001.wordBlob__read.success |
      | C001.wordBlob__read.invalid |
      | C001.wordBlob__read.preservation |
      | C001.wordBlob__read.bounds |
      | C001.wordBlob__read.wrongSubject |
      | C001.permissionUnknown__read.success |
      | C001.permissionUnknown__read.invalid |
      | C001.permissionUnknown__read.preservation |
      | C001.permissionUnknown__read.bounds |
      | C001.permissionUnknown__read.wrongSubject |
      | C001.capabilityUnverified__read.success |
      | C001.capabilityUnverified__read.invalid |
      | C001.capabilityUnverified__read.preservation |
      | C001.capabilityUnverified__read.bounds |
      | C001.capabilityUnverified__read.wrongSubject |

@C002 @F_READ @S_TABS
  Scenario Outline: Actual S02 inspection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C002.recursive__read.success |
      | C002.recursive__read.invalid |
      | C002.recursive__read.preservation |
      | C002.recursive__read.bounds |
      | C002.recursive__read.wrongSubject |
      | C002.selected__read.success |
      | C002.selected__read.invalid |
      | C002.selected__read.preservation |
      | C002.selected__read.bounds |
      | C002.selected__read.wrongSubject |
      | C002.all__read.success |
      | C002.all__read.invalid |
      | C002.all__read.preservation |
      | C002.all__read.bounds |
      | C002.all__read.wrongSubject |
      | C002.duplicateTitle__read.success |
      | C002.duplicateTitle__read.invalid |
      | C002.duplicateTitle__read.preservation |
      | C002.duplicateTitle__read.bounds |
      | C002.duplicateTitle__read.wrongSubject |

@C165 @F_ADJACENT @S_METADATA
  Scenario Outline: Actual S02 inspection [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C165.changeAwareness__read.success |
      | C165.changeAwareness__read.invalid |
      | C165.changeAwareness__read.preservation |
      | C165.changeAwareness__read.bounds |
      | C165.changeAwareness__read.wrongSubject |
      | C165.notReadProof__read.success |
      | C165.notReadProof__read.invalid |
      | C165.notReadProof__read.preservation |
      | C165.notReadProof__read.bounds |
      | C165.notReadProof__read.wrongSubject |
