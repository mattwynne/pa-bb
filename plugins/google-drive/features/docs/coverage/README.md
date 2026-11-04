# Independent Docs test vectors

Plan 026 retired this directory's acceptance/exposure engine. It no longer
contains an obligation manifest, registry, runner, outcome journal, intake or
coherent-forgery machinery. Nothing was moved to a nightly/legacy command.
Historical results are not fresh passes; the eventual capability catalogue in
plan 025 remains scope, not a prerequisite to ship a bounded operation.

What remains has a present test use:

- Literal provider inputs and independently authored expected facts under
  `fixtures/`; no compiler-generated verifier answers.
- Application/read, selection, discovery and witness executors/comparators that
  call the real core through in-memory external ports.
- Representative native/HTTP/SQLite companions and provider wire-schema probes.
- A small byte-digest helper, not evidence accounting.

Tests load selected vectors directly. They do not expand 11,197 obligations or
promote any pending capability. Repeated preservation fixtures with identical
source/expected data were deleted only where the success program already
asserts whole-source preservation. Original tracked bytes remain in Git.

[Testing commands and the retained-behavior map](../testing.md) describe the
current loop and its limits. `BRIDGE.md` is retained historical documentation of
the retired intake contract, not a current execution or exposure requirement.
