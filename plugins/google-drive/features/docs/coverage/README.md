# Coverage and wire audit

The [approved roadmap](../../../../../docs/plans/025-google-docs-semantic-api.md)
and contracts describe the full product. `obligations.json` is its **only**
machine manifest: 211 IDs, 1,190 base variants, 1,579 resolved variant/mode
combinations and 11,197 planned outcome keys. None is a passing test or enabled
semantic product. `registry.json` deliberately exposes nothing new.

## Execution and identities

`npm run test:docs` recursively discovers Docs features and step files, executes
Cucumber once, then audits its current message stream. It writes messages and a
summary to a uniquely created temporary directory and prints that path. A fresh
nonce and a before/after source fingerprint reject prior-run/source evidence.
The fingerprint includes top-level runtime registration/schema/server modules,
all package-local shared helpers, config and dependency locks. It excludes
installed dependencies, build outputs and unit-test transpilation scratch files.
Every discovered pickle must finish; every step/hook must pass. Undefined,
skipped, pending, retried or missing scenarios cannot count. OAuth remains its
own 12-case profile in `npm run test:acceptance`.

`baseline.json` is deliberately separate from future obligations. Its 30 S00
cases retain their actual feature/Scenario/Examples identities; three S01 real
application cases add applied-but-reply-lost and explicit wire preservation.
Each has an original fixture identity in `fixtures/index.json`. The runner joins
actual Cucumber AST row IDs/caseId cells, result attachments, driver/mode,
fixture bytes/digests/provenance, source fingerprint and the registry. The World
uses the shared hand-authored legacy before/request/after vectors; the baseline
fixture pins those vector bytes. It invokes real formatting/replacement services,
Google HTTP adapters and file-backed SQLite. It never returns fake semantic
success. Existing S00 race limitations remain in the [harness README](../README.md).

**Product intake currently has zero implemented semantic adapters and accepts no
semantic delivery or registration claims.** `product-intake.mjs` is a closed
code boundary, not a configurable whitelist of labels. A passing Cucumber case,
correct AST ID, fresh attachment, true booleans or matching digest cannot provide
semantic execution credit. Synthetic `auditControlOnly` fixtures are explicitly
refused on this path. Both registry-only and result-only claims fail closed.

Future slices must implement a real adapter tied to production registration and
schema, capture its actual application/provider invocation, and compare independent
before/request/readback/effects. Only then can planned concrete case IDs,
Examples, modes and fixture contracts become product evidence. No future
engine or fake successful adapter is supplied by S01. Declared delivery
requires current execution even without exposure. Exposure additionally requires
all sibling outcomes and explicit same-mode guard/failure/no-op, family, shared
and lifecycle-control dependencies. Direct and suggest never cover each other.

`control.mjs` creates temporary **synthetic inputs to test the auditor itself**.
Those dictionaries are not product execution evidence, are never loaded by the
runner as results, and never modify the product registry. They discard inherited
real delivery overrides/exposure/external state before constructing their own
control. The real-runner negative executes an actual counterfeit Cucumber case
and rejects it even when all its self-attested booleans are true. The negative Gherkin
and Node tests exercise missing cases/fixtures/dependencies, mode/driver/orphan
errors, refusals replacing N successes, stale results and external-gate
substitution. Node tests also corrupt actual Cucumber message/AST evidence and
remove every key in the 314-key bold/direct closure independently.

## Wire validation and oracle independence

The pinned official discovery artifact is test-only; see
[fixture attribution](fixtures/README.md). Structural walking covers declared
request mappings, references/arrays, writable paths and enum bindings for the
whole planned inventory. It does **not** verify future request payloads.

Actual payload validators are deliberately limited to `updateTextStyle`,
`updateParagraphStyle`, `updateDocumentStyle`, `updateSectionStyle`,
`updateNamedStyle`, `updateTableColumnProperties`, `insertDate` and literal
`replaceAllText`. Unsupported request validators fail closed. Supplied values
are recursively type/enum/output-only checked; precise masks, explicitly
allowlisted resets, named-style parent/type/child masks, whole paragraph borders,
pageSize/column width and complete PT dimensions receive additional checks.
A valid test vector is not evidence that its future semantic tool exists.
Future requests and additional reset semantics require their own reviewed rules
and independent vectors before exposure. This is not a complete Google validator.

The wire simulator imports no production planner/compiler/verifier. It only
handles whole-run bold and literal single-run paragraph replacement, one revision
transition, preserving unrelated fields. It rejects unsupported requests and
stale revisions without changing state. Hand-authored before/request/after
contracts test the simulator itself, including UTF-16/link/style preservation.
The real application adapter checks exact outgoing requests and complete
independent readback, not output generated by production planning helpers.
Applied loss and unapplied loss are distinct fixtures. Recovery never replays.

## Structural and teardown enforcement

Mode lists (including unused policies) are validated before expansion for nonempty,
unique, recognized/legal selections. Every intended base is resolved before records
are emitted; guards/failures/no-ops require a same-mode route/control. These checks
reject empty filters rather than relying on a final inventory count.

Manifest references are validated even with no exposure: dependency bases,
operations/rows, mode selectors, staged variants, external gates and profile
required/excluded outcome membership and disjointness. Unresolved selectors fail
for their named reason, never silently shrink a closure. This does not rely on
hardcoded inventory counts.

Nested paragraph-border and weighted-font-family constraints apply through
shared schema types, including named styles. A supplied font weight must be an
integer multiple of 100 from 100 through 900; omission retains the provider default. Date locations require explicit
tab/index (or an explicitly tab-bound segment end). Effect names, arrays,
resets and clear-all/mask/payload agreement are checked rather than ignored.

Every installed HTTP/DNS/HTTPS boundary retains unexpected-route and transport
contract failures. Batch decoding, root/collection/entry shape, request selection
and validation share one journaled boundary. This HTTP fixture intentionally
accepts only its two independently specified single-request vectors; empty or
multi-request batches are unsupported fixture inputs, not claimed Google errors.
Malformed inputs record exactly one contract fault; legitimate provider rejection
responses remain outside that boundary. World teardown checks all of them even if application code
swallows the immediate error, and always disposes SQLite in a finally path.
A deliberate negative may acknowledge only its exact asserted single fault;
replacing a boundary or acknowledging one fault never exempts later faults.

## External gates

Rendered BB, applied-code observation, review and delivery evidence stay in
`externalGates`; Cucumber/unit success is rejected as a substitute. Shape checks
for attributed external references are not certification of their truth. No
UI was changed by S01 and no live provider/deployment evidence is claimed.
Full future closure remains an S16 gate; this foundation intentionally reports
zero executed semantic obligations rather than promoting partial legacy evidence.
