# Docs development feedback

[Plan 026](../../../../docs/plans/026-docs-simplification-and-fast-feedback.md)
supersedes the acceptance-count-driven sequence. ADR 0003 applies: test real
business behavior in memory, HTTP translation with substituted transport, and
SQL/SDK promises with a real temporary database. No connected Google calls are
part of these commands.

## Development runtime

Use **Node 24.21 or later in the Node 24 line** for development/tests; the
checkpoint was tested on 24.21.0. The test runner uses `--test-isolation=none`
and `registerHooks`, which are not available throughout Node 22. This does not
change the deployed plugin's `engines.node >=22` declaration or claim that every
Node 22 release can run the development commands. No runtime upgrade is implied.

## Commands (from `plugins/google-drive`)

| Command | Purpose |
| --- | --- |
| `npm test` / `npm run test:docs:edit` | Normal affected-edit loop: legacy literal edit, real composition model/planner/compiler/verifier, and immutable-model validation regressions. No build, SDK, SQLite, process launch or network during cases. |
| `npm run test:docs:fast` | Compatibility spelling for the same affected-edit loop, not a claim to run every core case. |
| `npm run test:docs:core` | Full maintained pure-core/application suite, including all retained read/selection/witness vectors, policy and original leaf-algorithm mutants. This is broader and slower than the affected-edit loop. |
| `npm run test:docs:adapters` | Real adapter/decoder/transport, strict composition schemas, privacy sentinels, and a separate runner-boundary calibration. Only the calibration launches a bounded child. |
| `npm run test:docs:integration` | Focused real file-SQLite/SDK authorization, claims, draft storage, dispatch, recovery and no-replay checks. Still slow; not the editing loop. |
| `npm run test:docs` | Explicit core + adapters + focused integration, each once. No acceptance producer, build, source fingerprint or obligation intake. |
| `npm run test:all` | All remaining Node files, including unfinished local table tests when present. Not certified by this simplification checkpoint. |
| `npm run test:oauth` | Separate OAuth Cucumber checks. |
| `npm run build` / `npm run typecheck` | Separate build and declaration checks; neither reloads an installation. |

## Broader Drive review/delivery recipe

The affected default and focused Docs checks are **not whole Drive validation**.
For broad Drive/shared-interface review, from this package, explicitly run:

```sh
node ../../scripts/sync-connection-ui.mjs --check
npm run build
npm run typecheck
npm --prefix ../google-calendar run build # OAuth cross-plugin fixture dependency
npm run test:oauth
node --test --test-concurrency=1 $(find test -name '*.test.mjs' ! -name 'docs-table-*.test.mjs' | sort)
```

This POSIX recipe runs retained Docs and adjacent Drive/Sheets/copy/sharing/
filing/upload Node tests once, rather than running `test:docs` and duplicating
those cases. For a bounded feature change, select its affected existing files
instead, including relevant host/HTTP/storage boundaries. Use foreground time
bounds and synthetic temporary data. Do not infer a passing broad review from
`npm test`, build, or typecheck alone. The deferred local table files are excluded
explicitly because that unfinished candidate is not certified; `test:all` still
includes them if present. Their exclusion does not mark them passing. No old
obligation runner, release publication or live provider action is required.

The affected-edit target is **500 ms end-to-end**, including npm, Node startup,
fixture discovery and assertions. Measure with a fresh process, for example:
`env -u NODE_OPTIONS /usr/bin/time -f '%e' npm test`.
Report the first process and repeats; do not describe a warm function benchmark
as suite time or call filesystem-cache-warm runs OS-cold. Measure the full core
suite independently. Large generated pagination vectors and diagnostic trace
cloning still make that suite take seconds; SDK composition graph checks are
slower again. Neither limitation is a reason to run them on each leaf edit.

Node's `--test-isolation=none` avoids a new process/import graph for each pure
file. `fast-boundary.mjs` blocks SDK/SQLite imports, process/worker and network
builtins (both aliases), plus global fetch. Fixtures and mutation source are
loaded before cases; actual cases call real core functions. The boundary
calibration verifies forbidden imports without opening external systems.

## What was removed, and what still checks the behavior

- Deleted the unregistered adoption/exposure engine: runner, intake,
  coherent-forgery sandboxes, child outcome journal, obligation expansion,
  registry and duplicate Cucumber execution wrappers. No replacement ledger or
  nightly copy exists. The eventual capability catalogue stays in plan 025 as
  scope; historical reports remain historical, not fresh passing results.
- Removed ledger-only tests and their generated draft/native/c009 corpora.
  Direct draft/regression, actual storage/port contracts, native protocol and
  writer-coordination suites remain. They check behavior, not accepted counts.
- Removed 40 application fixtures whose provider/expected data exactly matched
  their success counterpart apart from case/outcome labels. Their instruction
  programs had no preservation-specific branch: success already checks exact
  original provider/model/unselected-content preservation. The two structurally
  different preservation examples remain.
- Reduced repeated discovery ownership permutations. Retained recursive
  diagnostic cursor ownership/expiry, metadata-only changed identity and the
  actual native file-metadata wrong-subject case. Other subject-binding and
  authorization refusals remain in application, HTTP and SDK boundaries.
- Replaced obligation expansion in application/selection/witness tests with
  direct loading of independent literal vectors. No new outcome is promoted to
  accepted and fixture paths cannot select an easier executor.
- Composition verifier no longer boots SDK/accounts/Reader/file SQLite just to
  compare documents. Handwritten raw before/after/wire vectors are shared with
  the integration tests. It still checks astral growth and shortening, complete
  whole-block wire order, multiple tabs, named/default font ownership, and 13
  independent content/style/coordinate/opaque-field mutations. Schemas have a
  separate boundary test.
- Removed proof-file hooks and redundant proof hashes from composition/recovery
  tests, retaining query-only SQLite, complete row comparisons, forbidden-write
  traps, outside-transaction HTTP checks and exact receipt assertions.

`validatedReadModel` independently rebuilds and compares a caller model before
reuse. Only recursively immutable data-descriptor inputs are memoized. Mutable,
shallow-frozen and accessor inputs revalidate. Forged frozen graphs still fail;
plan and witness revision bindings do not alias. This eliminates repeated
materialization without trusting checksums or caller-supplied graph facts.

Unfinished table source remains deferred and unregistered, with its exact
pre-simplification candidate preserved privately. No table tests are presented
as acceptance. Historical migrations, legacy tools, approval settings, subject
binding, required revisions, receipt interpretation and uncertain-write holds
are unchanged. Build/test success establishes neither rendered BB behavior nor
live activation. This checkpoint does not deliver a new create/edit workflow.
