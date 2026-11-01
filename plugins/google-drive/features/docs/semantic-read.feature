@docs @F_READ
Feature: Native semantic reads use real bounded snapshot evidence
  Scenario Outline: Inspect and read an explicit projection [<exampleId>]
    Given the offline semantic native host and independent rich document
    When the semantic projection "<projection>" is requested
    Then the independent semantic expectation for "<projection>" matches
    And semantic reads sent zero provider mutations
    Examples:
      | exampleId | projection |
      | snapshot.structured | structured |
      | snapshot.text | text |
      | snapshot.header | header |
      | snapshot.footer | footer |
      | snapshot.footnote | footnote |
      | snapshot.deniedComments | deniedComments |
      | snapshot.nonEditor | nonEditor |
      | snapshot.markdownKind | markdownKind |
      | snapshot.wordKind | wordKind |
      | snapshot.opaque | opaque |
      | snapshot.crossRun | crossRun |
      | snapshot.chipBoundary | chipBoundary |
      | snapshot.unknownDefaults | unknownDefaults |
      | snapshot.wrongSubject | wrongSubject |
      | snapshot.wrongThread | wrongThread |
      | snapshot.snapshotExpiry | snapshotExpiry |
  Scenario Outline: Provider failures produce bounded safe diagnostics [<exampleId>]
    Given the offline semantic native host and independent rich document
    When semantic inspection encounters "<fault>"
    Then semantic inspection fails safely without provider mutation
    Examples:
      | exampleId | fault |
      | failure.denied | providerDenied |
      | failure.overrun | overrun |
      | failure.encoding | invalidUtf8 |
      | failure.transport | transport |
      | failure.view | wrongView |
