# S02 D/E: offline execution bridge

Four D cases remain supplemental **candidate evidence**, not delivery or
exposure. Bounded E executes two normal C006 exclusions, sixteen normal C009
invariant outcomes, thirty normal C005 projections, twenty normal C006
structural outcomes, twenty normal C007 rich-cell outcomes and twenty-five normal
C008 opaque outcomes, twenty normal C003 segment outcomes, twenty normal C010
view outcomes, fifteen normal C011 review-view outcomes, twenty normal C012
literal-search outcomes, forty normal C013 normalization outcomes and ten C015
local cardinality invariants through this same bridge. The wrongThread pair,
all three text candidates, sole literal candidate and exactly two cardinality
candidates were migrated, not duplicated.
**129/367 S02 keys remain mechanically unclosed**; accepted accounting stays
228/367 until independent C015 review. Forty-two read closures are mechanically complete;
the other 17 and all serving exposure remain unclosed. Normal source evidence
still requires independent review. No future cases are
skipped or counted as passes. `server.ts` and agent
configuration remain unchanged. Source inventory is not applied-runtime evidence.

## Traceable path

`semantic-bridge-d.feature` → `steps/bridge-d.steps.mjs` → `bridge.mjs` →
`execution-adapters.mjs` → real native registrar/schema/service/Google adapter and
file-backed SQLite, or real production internal function → independent inert
fixture comparison → transport-journal checks and database disposal → descriptor
3 execution record → normal runner/current Cucumber AST/Examples join →
`product-intake.mjs` comparison → supplemental candidate count.

A step gets only a reference and binding envelope. It cannot submit an execution
record or pass a callback that supplies one. The record is published only after
actual invocation, comparison and teardown. The parent independently repeats the
fixture comparisons. Nonce, source fingerprint, actual pickle/Examples IDs,
execution instance, exact case/driver/schema/mode, fixture bytes and provenance
all join. A record cannot be reused, omitted, replayed across runs, attached to a
different case, or left orphaned. Self-attached flags (including all true) are not
consulted. Interrupted or failed child runs cannot earn credit.

This is a **trusted test-harness boundary**, not a cryptographic attestation
system. It catches counterfeit attachments, missing invocations, accidental
misbindings and mismatching observations. Arbitrarily malicious repository code
can write the inherited descriptor or replace the recorder/comparator; malicious
process/DB rewrites are outside this threat model and require code review. The
source fingerprint detects changes during a run, not a malicious test author.
The record contains only synthetic fixture data; never run this harness against
real accounts or storage.

## Actual inventory, not a second capability declaration

`support/production-host.mjs` transpiles the current TypeScript factory into an
owned temporary directory (never `dist`), resolves one fixed local test import
through a narrowly scoped Node loader hook that is deregistered immediately, and installs it on the official offline
host, captures real Zod parameters and execute functions, and resolves actual
agent configuration. Thus C165 uses the existing `gdrive_get_file` registration,
`createDriveService` dispatch and real `drive.getFile`, not semantic inspection.
The factory's adapter captures a closed synthetic fetch during construction; it
has no live fallback. Ambient fetch, HTTP/HTTPS, DNS and socket entry points are
also blocked for the host lifetime, journalled even if their errors are caught,
and restored during cleanup. Temporary source is removed; the host owns SQLite
cleanup.

The same host then invokes the still-unwired `registerSemanticReadTools` for
`docs_inspect`, `docs_read`, and `docs_find`. Actual schemas are compared with their
production exports AND the separate hand-authored
`fixtures/bridge-schema-contract.json`. The latter is not extracted from actual
source: it describes the complete recursively reachable input/output schemas for
the four bound native tools, including properties, requiredness, types, bounds,
unions, enums and object policies. Only schema description/dialect annotations
are ignored, never properties named `description`. Native metadata retains its
existing accept-and-strip policy; semantic objects remain strict. Actual registered
schemas also exercise valid/invalid heading, section and nested-before refinements,
which JSON Schema does not represent. These are capability checks, not blanket E
behavior coverage. Fresh source fingerprints do not approve a changed contract. Metadata is already in the legacy serving configuration; the three
semantic tools are absent. No serving installation is inspected or changed.

The executable evidence registry is deliberately narrower than source API
availability. Its seven D adapters are:

| Canonical operation/variant | Actual path |
| --- | --- |
| `docs_inspect.kind/nativeDoc__read` | native inspect schema/service/GET/store |
| `docs_read.projection/text__read` | native read schema/service/stored page |
| `docs_find.literal/crossRun__read` | native find schema/service/selector |
| `snapshot.coverage/wrongThread__local` | real SQLite `semanticSnapshots.get` |
| `selector.cardinality/exactlyOne__local` | production `resolveSelector` |
| `coverage.witness/broadDelivered__local` | production `coverage.footprint/evaluateWitness`, actual stored deliveries |
| `gdrive_get_file.metadata/fileMetadata__read` | existing native metadata route |

The historical twelve-candidate profile exercised these routes: four read successes, schema-invalid
and wrong-subject reads, and three local positive/counterexample pairs. Each route
also gates its exact implemented outcome set: an ordinary success cannot be
relabeled `bounds` or `preservation`. Comparison checks actual `text` format,
cross-run span intersection, `exactly:1` cardinality and broad stored-node delivery,
not just the route label or fixture declaration. The
invalid text read supplies an empty snapshot ID and makes **no read invocation or additional provider GET** after its
setup inspection. The wrong-subject read uses a second synthetic verified account
and subject on the SAME thread. Capture observes that verified identity and the
actual native snapshot-access owner/error; the parent requires the precise
subject/account mismatch and unchanged thread. Wrong-thread or generic access
errors cannot substitute for `wrongSubject`. C009 separately retains its actual
wrong-thread pair. Local comparison success never implies approval,
acknowledgement, a writer claim, or authoring authority. C021 retains the approved
manifest's `coverage-auditor`/`coverage.manifest-and-witness` names, but executes
production `core/docs-semantic/coverage.mjs`, never synthetic `control.mjs`.
Internal schema names are contract IDs, not invented public Zod tools.

## Local invocation capture

`support/local-invocations.mjs` binds selector, witness and store methods to actual
production imports/store functions. Routes cannot supply callbacks or records.
The private recorder clones/freezes actual arguments, model identity/revision/hash,
result or typed error and a unique invocation ID/count. Each local route must
produce exactly its expected invocation, whose observed result must equal the
route output. The parent repeats this check and rejects invocation reuse across
receipts. Removing either decision call or the store call while returning fixture
expectations now fails with recorder and comparator untouched. The original
function-name dictionary is diagnostic context, not proof of invocation.

## Resource and lifetime limits

Publication and parent intake independently enforce a 4 MiB record (including
newline), 64 MiB aggregate execution journal, and 1,024 records—more than the
367 S02 outcomes. Parent intake checks file size before allocation and reads
64 KiB chunks, bounding each line/count before JSON parsing. Truncated, malformed,
invalid UTF-8 and oversized journals fail and remain available for inspection.
The Cucumber message stream is separately bounded at 4 MiB per envelope, 128 MiB
aggregate and 100,000 envelopes. These are wire-input bounds, not exact JS heap
or OS disk quotas; a malicious writer bypassing the trusted publisher is outside
the harness threat model. E must use bounded evidence representations rather than
silently expanding these limits for large source documents.

The child defaults to 300,000 ms. `DOCS_ACCEPTANCE_TIMEOUT_MS` accepts a positive
integer up to 600,000 ms (including smaller values for safe timeout probes).
Timeout kills the child, records its status and preserves partial artifacts, but
never permits credit even if records were already published. Error exits likewise
refuse all credit. The runner prints its artifact directory and saves run identity
before inventory/child execution. Ordinary 367-record boundary tests, sparse
oversized files, count/line overruns and actual timeout-after-publication tests
avoid resource-exhaustion experiments.

## Bounded E raw-mask exclusion (not whole-S02 completion)

The eighth adapter is `policy.publicRawMask/refuseRawMask__capability`, bound to
`schema-policy-refusal` / `explicit-excluded-operation`. Each of its two normal
Examples independently exercises all six currently bound native input branches:
inspect/read initial and continuation, find literal query and selector. The
actual registered schemas accept the paired inputs without `fields`; the actual
native host rejects each masked input with its exact unknown-field error before
execute. The capture privately binds the original official dispatcher before
exposing the host; a replaced dispatcher is refused before recording, never
called as a substitute. The immutable host capture holds original arguments,
paired parse, unique invocation/sequence and actual error. Parent checks branch identity,
paired input equality and exact host error, not merely a schema-failure flag.
There are zero observed execute calls, provider/identity requests or snapshot
accesses. No read-success, account-access or content-preservation capability is
inferred from these capability-only refusals.

Storage evidence uses two immutable observations from fixed prepared queries on
the actual host connection, not route-provided counters, connections or callbacks.
The parent requires one connection ID and unchanged `total_changes()`, database
scope, and main/temp schema state. The schema digest includes tables, indexes,
views and triggers (type/name/table/rootpage/SQL); schema_version also detects
ordinary create/drop pairs. Metadata includes user_version, application_id,
page_size, page_count, freelist_count, auto_vacuum, encoding and journal_mode.
These are observed before/after facts, **not proof of zero attempted writes or
all possible database activity**. For example, rolled-back DDL may restore the
observed state; transient attach/detach, external connections/files and unlisted
connection settings are not audited. No data-row scan or database serialization
is used. Counters observe this connection's counted row changes, not every
SQLite operation. Database attachments beyond main/temp are refused.

Capture is bounded to two observations, 128 schema entries per scope, 256-byte
names, 8 KiB SQL per entry and 256 KiB total schema text per scope. Scope queries
return at most three rows (the third refuses an attachment); file paths are
bounded and recorded only as digests. Prepared query functions stay private;
replacing the public connection's prepare method cannot fabricate these reads.

`fixtures/raw-mask/generate.mjs` is a readable original input/control matrix; it
imports no production parser or projector and never derives expected values from
execution. Two independent inert fixtures, normal fixture-index/registry entries
and per-key delivery declarations join the unchanged recorder/current AST/intake
path. Declarations never bypass current-run validation. Native capture IDs cannot
be reused across cases. Normal fixtures now also have a reverse-orphan check.

The two exclusions retain their original assertions. Historical D mutation tests
restore their twelve candidate rows in disposable copies using the unchanged
archival fixtures; they clear unrelated normal registry/ledger declarations.
Raw-mask-only mutation runs likewise isolate their own declarations. Neither
isolation changes live normal discovery or weakens an injected fault's assertion.
The full runner reports forty-eight normal outcomes and seven candidates, and writes
all 367 keys and every missing dependency to `s02-accounting.json`. Exposure
remains empty; no runtime, rendered or authoring credit is claimed.

## Normal C009 integration

`semantic-c009-e.feature` supplies sixteen concrete normal Examples. Independent
inert vectors under `fixtures/c009/` describe provider bytes, typed node facts,
exact text/omissions and boundary values; their generator imports no production
projector, model, selector or effect builder. The pinned style presentation reuses
the independently authored C witness vectors, not an observed output oracle.

`c009-execution.mjs` extends the same execution/comparison channel. The native
boundary privately retains the official dispatcher. `c009-invocations.mjs`
privately binds fixed production store/read-evidence methods and fixed prepared
queries to the real disposable connection. Routes cannot supply callbacks, SQL,
clock getters, alternate functions or writable records. A substituted exposed
store method or dispatcher is rejected. Actual immutable arguments, results or
typed errors, unique IDs, monotone clock and native/local causal sequence are
captured. Connection/file identities cannot be reused across normal cases.

The parent consumes every call in order and checks independently authored
model/node/text facts, exact frozen cursor state and deadlines, stored delivery
nodes/aspects/omissions, original-model bindings and database seals. State reads
are limited to 128 rows per known table, 64 KiB cursor/delivery payloads and a
512 KiB observation; no arbitrary database or row query is exposed. The existing
4 MiB/64 MiB/1,024-record journal limits and child timeouts are unchanged.

Cursor pairs exercise the exact 299,999/300,000 boundary, successful native
single-use publication and actual indivisible packing failures with retained
cursor and durably charged work, followed by real consumption/replay refusal.
Snapshot pairs exercise 599,999/600,000 with retained pins that cannot renew
ordinary reads. wrongThread preserves subject/account and checks a real existing
snapshot separately from a missing-ID control. Empty/partial outcomes distinguish
materialized data, exact delivery and an insufficient destructive-parent witness.
Overrun streams have no Content-Length: the real adapter accepts exactly 8 MiB
and rejects one extra byte; emitted chunk bytes, native result and storage state
are observed, not represented by an expected failure flag.

Pinned cases evaluate an independent exact style presentation, retain actual
stored delivery references, and consume only that saved witness after ordinary
snapshot expiry. They check owner, digest, immutable deadline, 32-pin cap,
release and pin expiry. Results remain `retainedEvidenceOnly`, with no current
read authority, editReady, approval, S03 draft or executor acknowledgement.
All 58 new read closures have their sixteen C009 dependencies. Six C005 and
four C006 closures additionally have their own five outcomes; the other 48 new
read closures and the metadata closure still lack their five read outcomes.

## Normal C005 projection integration

`semantic-c005-e.feature` supplies thirty exact Examples: text, structured,
styleAnnotations, reviewAnnotations, omitImages and continuation, each with
success, invalid, preservation, bounds and wrongSubject. The independent inert
vectors include cross-run UTF-16/newline facts, typed parent/child coordinates
and opaque evidence, direct/named/unknown style facts, real review anchors and
missing-review fallback, image references/omission losses, and unselected text.
Neither the fixture generator nor parent comparator imports a production model,
selector or projector to compute expectations.

`c005-execution.mjs` uses the existing journal and parent intake, real native
schemas/registration/service, and the same private file-SQLite observation
boundary. A fixture-derived instruction iterator describes actual calls; it
cannot contribute expected results or recorded success flags. Parent comparison
checks literal typed records, annotations, provenance, losses, selection scope,
all public/delivery/cursor envelopes, durable logical-byte charges and seals.
The host privately binds original get/peek functions and records actual safe
owner arguments and binding/error, linked to the native call UUID and sequence.
No authentication tokens or owner credential records enter this capture.

Wrong-subject reads use a verified second principal on the original snapshot
and same thread; continuation uses its correct existing cursor. Strict invalid
options have valid paired calls, including a forbidden cursor retarget. Bounds
exercise real indivisible text/opaque/style/review records against the default
64 KiB page cap, and actual 3,000-byte continuation and omission-only loss pages.
Failed packing retains its cursor and original deadline but remains charged.
Single-use, replay and exact expiry checks use real native continuations. Scope
and order are frozen, and final receipts require every record and orphan loss.

Preservation compares original source, exact model (including unselected scope)
and stored snapshot seals/deadlines while permitting legitimate delivery/work
writes. It does not claim zero attempted SQLite writes. Only closed synthetic
GETs are available; assets and provider mutations have no transport route.
Thirty passing-child, parent-only fault controls exercise every normal key, plus
missing receipt/result/private access, outcome swaps, reused identities and
connection/file reuse. These implementation tests are not independent acceptance.

## Normal C006 structural integration

Twenty exact Examples bind styles, objects, ranges and suggestions to all five
read outcomes. They call the existing native `docs_read` with `format:structured`
and `registries`: styles/lists, objects/diagnostics, ranges, or review respectively.
This is the readable diagnostic path implemented in A, not inspection counts,
C005 annotation relabelling, a new public API or later identity selection.

Independent authored vectors contain named/list/page definitions and explicit
paragraph/run dependencies; direct, inherited, partial and unknown style facts;
inline/positioned definitions and resolved/unresolved references; inert image URIs
and opaque diagnostic values; duplicate-name multi-ranges with exact tab/segment
coordinates, incomplete/reversed ranges and excluded unselected/header scopes;
and actual insertion/deletion/style/structural suggestion relationships. Review
fallback retains suggestions without manufacturing available comments coverage.
Definitions and references remain distinct from semantic content identities.
Diagnostic aspect delivery cannot authorize edits or claim rendered objects/fonts.

The C005 fixed native capture and exact envelope/state comparison are reused,
not copied. C006 validates its own declarations, original typed model, complete
registry definitions/references and independently specified diagnostic records,
losses, scope relations and aspects. Initial and continuation owner failures use
the verified second principal on the same thread with the original snapshot and
correct cursor, correlated to private native UUID/sequence records.

All modes genuinely page diagnostic records at a 6,000-byte supported test limit;
the default production cap remains 65,536 bytes. Actual oversized indivisible
registry definitions fail twice at that default cap while charging completed work,
with valid structural controls. No production cap, application or store changed.
The native host's small offline limit allowlist adds only the existing A test
value 6,000. Twenty actual-child parent-only faults cover each exact join; cross
C006/C005/C009 native/local/database identities remain nonreusable. Historical
12-D+2-E, 18-normal+10-D, 48-normal+7-D and 68-normal+7-D scopes are disposable-only controls,
never current normal credit. Independent review remains a separate gate.

## C007: rich cells, not strings masquerading as tables

Twenty concrete Examples cover adjacent styled runs, inline-object relationships,
nested physical tables and original paragraph newlines. Each fixture contains a
real table cell, an unselected neighbor cell and outside paragraph. The provider,
full typed tree, UTF-16 coordinates, styles, physical grid, opaque evidence,
definitions/references and projected records are authored independently. No
production materializer, projector or selector computes the expected values.

Existing node/span selectors are bound from observed snapshot paths, then checked
against the authored identities. No new cell selector or authoring interface is
introduced. Text reads preserve run boundaries, surrogate pairs and decomposed
Unicode, including an empty paragraph's original LF. Only delivered text nodes,
not parent-cell structure, get content/style delivery. Structured reads preserve
cell/row/table hierarchy and object references; inert image diagnostics do not
fetch assets or promise rendered fidelity.

Invalids exercise real reversed sibling spans inside the cell, followed by valid
reads. The shared comparator adds an exact `scope` refusal state: no read-ID
allocation, no work or publication, and unchanged SQLite observation. Existing
C005/C006 fault anchors and comparisons remain intact. Every normal rich-cell
read actually continues at 6,000 bytes. Bounds use valid smaller controls and two
failed initial indivisible rich-cell projections at the unchanged 65,536-byte
production limit; completed work remains charged. They are not new failed-
continuation evidence. Wrong-subject cases use both original snapshot and actual
existing cursor on the same thread, with verified second-principal/private-access
correlation and subsequent original-owner completion.

Twenty passing-child parent-only faults cover all exact keys, including modified
Unicode/LF/object/grid output, absent real invalid calls, extra durable work and
substituted refusal causes. This extends the same journal/intake; no alternate
acceptance pipeline or production code change is implied. These source results
still require independent review, and S02 remains incomplete.

## C003: explicit stored segment identity

Twenty exact normal Examples read body/header/footer/footnote content in an
explicit second tab, with actual snapshot-derived segment-root handles. Two
headers and two footers, a body footnote reference and separate note content,
and another first tab preserve distinct identities despite overlapping indices
and similar text. Independent provider/typed trees, styles, UTF-16/LF facts and
raw digests are never generated by a product parser/projector/selector.

The unchanged shared read comparator checks all native calls, private original
snapshot/cursor access, closed GET transport, complete output envelopes,
selection/request freezing, seals, durable work and publication. Body invalid
uses duplicate-body scope refusal; header/footer use wrong-kind IDs and
footnote uses the other tab's note ID. A foreign scoped node genuinely resolves
as missing, not an invented ambiguity/refusal. A body scope cannot accept an ID
at the schema boundary. Neither is substituted for these actual scope probes.

Normal reads page at the existing6000 test seam. Bounds publish a genuine
segment first page at the unchanged65536 default, then two indivisible-record
continuation failures: completed work stays charged, the original cursor stays
available, and no failed page is published. WrongSubject uses a verified other
principal on the same thread with original snapshot/cursor, then owner recovery.
Reference delivery is not note-content delivery or vice versa. No rendered
first/even-page layout, note numbering, writer or whole-document authority is
claimed. Production, native host and shared comparison code are unchanged.

## C008: opaque API evidence, not interpreted or rendered output

Twenty-five concrete Examples cover auto-text, drawings, equations, TOC and
unknown nodes through the same native read capture and parent intake. Independent
literal fixtures retain complete typed trees, UTF-16 coordinates, raw paths and
canonical API-value digests, references, unselected unknowns and exact losses.
No production helper generates expected values, and no new runtime API is added.

Auto-text retains its provider kind/style without a calculated page value;
equations retain opaque API properties without text/LaTeX reconstruction. TOC
reads preserve actual containers/entries/child order, not live regenerated TOC
certainty. Drawing definitions/references are diagnostics with an unknown object
kind: no image/media fetch, hosted asset or rendered bytes. Unknown diagnostics
retain mapped and unresolved source evidence with no content/style/review grant.
An unprojected paragraph field remains omitted from ordinary semantic coverage;
diagnostic delivery never transfers authority to its owner or whole parent.
Unknown cases additionally make an ordinary structured read across an unresolved
opaque node and the paragraph with an unprojected field: exact null extent,
`unknownFieldOmitted` loss and missing whole-page aspects remain observable.
The shared comparator adds only an explicit `opaqueControl` oracle role for that
native call; every original envelope/state/work comparison remains unchanged.

Each case performs an actual text-projection control whose non-text loss names
the selected feature. Reversed spans fail natively, then the identical forward
span succeeds with only its endpoints reversed. Surrounding/unselected source
stays intact. Unresolved unknowns outside the exact read do not blanket-block it;
retention is not mapped authoring/witness safety. There is no C021 promotion.

Primary normal reads genuinely page at the existing 6000-byte test seam. Bounds
use valid feature controls and two indivisible-record/diagnostic initial failures
at the unchanged 65536-byte default, charging both completed projections without
publication. They are not new failed-continuation proof. Wrong-subject probes use
the same-thread original snapshot and actual cursor, correlated to private
original access, followed by original-owner completion. Twenty-five passing-child
parent faults and opaque semantic neighbors exercise these exact distinctions.

## C010 provider views and non-authoring projections

Twenty exact keys use actual `docs_inspect` requests for inline, accepted and
rejected views, then `docs_read` against the retained view-bound snapshot. Each
fixture independently supplies three distinct provider responses: inserted/deleted
text, proposed/applied style and view-specific UTF-16 positions. Returned enums,
actual GET query, raw/model evidence, review annotations, typed projections,
coverage, cursor and delivery bindings must agree. The same native Docs revision
in different views does not make their content or coordinates interchangeable.
Preview comments/review coverage is not invented.

The shared read comparator has a closed C010-only view parameter; all previous
wrappers remain strictly inline. No previous semantic comparison is skipped.
`projectionNotEditProof` invokes the existing private, production-bound
`coverage.evaluate` capture with actual stored delivery tokens. The real
`coverage.evaluateWitness` result must retain `currentEditorRevision` as missing,
`witnessSatisfied:false`, `editReady:false` and no authoring authority. This is
read diagnostic evidence, not a new public tool or C021 completion.

Invalids attempt to retarget an actual cursor with a different view: the native
read schema refuses **before service invocation**, with no new HTTP/private
snapshot access or state/work change; the original cursor still completes.
Bounds publish a real first page at65536, then retain the same view-bound cursor
through two charged failed continuations, without publishing either failure.
Wrong-subject calls use the correct snapshot/cursor, a verified second principal
on the same thread, exact private get/peek correlation and original-owner recovery.
Stored API previews establish neither editor CAS authority nor rendered fidelity.

## C011 denial, missing review and scoped inline annotations

Fifteen exact outcomes reuse the native read pipeline. Denied comments produce a
real comments-aware403 followed by a distinct content-only GET, keeping all-tabs
and inline-view query values. Successful content is useful partial evidence, not
a relabelled denial. Missing-review vectors omit the returned comments mode,
retain unresolved references/unanchored definitions and explicit diagnostic
losses; an empty comments array alone cannot establish inspected review coverage.
The nested-tab vector keeps body/header anchors, equal local indices, similar
text and suggestion IDs attached to their actual contexts. Other tabs and
undelivered ancestors are not credited. This does not promote C002 or discussion
or suggestion editing.

An actual structured annotated-text control precedes scoped review diagnostics.
The existing private production coverage guard compares the real stored control
token against a review-only footprint: unavailable review stays incomplete;
known scoped review may satisfy that narrow read witness, never editReady or
blanket authoring authority. The new common missing-review expectation and local
instruction are closed to C011; previous inline/view comparisons stay intact.

Invalids add a review option to an actual cursor and are native-schema refusals
before service invocation; original cursors complete. Bounds publish a genuine
first diagnostic page at65536 then fail twice on an indivisible thread record,
retaining exact cursor/view/scope and durably charging each completed projection.
Second verified principals use the same thread and actual original snapshot and
cursor, with private get/peek correlation and original-owner completion.

## C012 literal search: native matching, not read-page authority

Twenty exact outcomes use actual `docs_find` after native inspection, authenticated
closed GETs and a sealed file-backed snapshot. An independent Node-only generator
authors typed trees, raw paths/digests, styled UTF-16 fragments, source extents and
literal context. No matcher, normalizer or observed output generates expectations.
The former cross-run D candidate is removed from current supplemental discovery;
its unchanged fixture and assertions remain available only in historical profiles.

Literal matching crosses contiguous styled runs, not paragraphs, person chips or
source-index gaps. A stored terminal LF remains searchable within its paragraph.
Positive side/contiguous controls distinguish an actual barrier from an empty
search. Exact case/decomposed text is not implicitly folded or NFC-normalized.
Context is bounded to40 UTF-16 units per side, with surrogate-edge adjustment,
including paragraph starts/ends and scope isolation from another tab.

Actual bounds distinguish65536/65537 contiguous units,262144/262145 scanned units,
500/501 matches even when limit1 returns one candidate, and eleven/twelve long
candidates around48000 bytes. Query length is capped at2000 and the public envelope
at65536. Refusals repeat without inventing pagination or partial success. Count,
returned candidate count and truncation are separate checked facts.

The lone-surrogate invalid reaches the scalar service refusal; limit0, regex and
context overrides are native-schema refusals. Verified second principals use the
same thread and original snapshot, with exact private get UUID/sequence/key/owner
correlation and original-owner recovery. Actual599999/600000 expiry is checked.

Find preserves snapshot/model/seals/deadlines and creates no durable read-work,
read cursor or delivery token. This does not claim zero attempted database writes
for inspection. Search returns `readProof:false`: candidates are not current-editor
CAS, match proofs, cardinality approval, read witnesses or authoring authority.
C012 did not promote normalization, cardinality or future selectors. It required
no production, host/capture, shared read-comparison or public schema change.

## C013 normalization: independent policies and original coordinates

Eight variants × five outcomes execute registered `docs_find`: exact defaults,
typographic, NFC, simple-case-fold, inverse maps, emoji, combining marks and RTL.
`c013/generate.mjs` authors original provider/model trees, style/evidence paths,
query pairs, UTF-16 spans, run fragments and context independently. The separate
C013 parent comparator reuses only the unchanged native/GET instruction executor;
C012 and the native host/private-access captures remain unchanged.

Typography maps punctuation and consecutive Unicode spaces; NFC composes and
reorders across styled runs. Transformed-cluster partial boundaries are refused,
while unchanged scalar boundaries remain valid. Simple folding is independently
selected: the reviewed Greek exceptions work in both directions, alongside
sharp-S/sigma/Cherokee/ST controls and Turkic/full-expansion/implicit-NFC exclusions.
Unicode17 provenance is pinned runtime evidence, not future-policy certification.
Source text, logical RTL order and original context are never replaced by normalized
offsets or display order. Emoji context may expand one unit at an edge solely to
avoid splitting a surrogate pair. Paragraph/chip/gap/tab barriers are exercised
under every normalization policy, with positive controls.

Named valid/refused boundaries are run65536/65537, raw scan262144/262145 despite
space collapse, NFC16384/16385, cluster4096/4097 despite composition, attempts65536/65537,
matches500/501 with limit1, candidate48000 bytes and literal2000/2001. Attempts use
one shared large tab plus one additional attempted partial-cluster match in an
explicit combined scope, rather than duplicating oversized model reservations.
The literal limit is a native-schema refusal, unlike service-budget refusals.
Every refusal repeats and then recovers the valid control. All successful envelopes
remain within65536; the lower candidate cap precludes an independent page-limit
crossing here, so no such boundary claim is made.

Inspection writes its real snapshot. Find preserves that snapshot/seal/deadline
and produces no durable read-work/cursor/delivery/pin or read/authoring authority.
Wrong-subject probes use a distinct verified principal on the SAME thread and
original snapshot, with original-owner recovery and actual expiry. Forty passing
children with altered actual native behavior are rejected by the parent; each test
asserts the exact first failure, not an earlier serializer/work/setup refusal.
The schema-bound RTL fault retargets the oversized query and is rejected at original
argument binding, not credited as bypassing the independent schema contract.

C013 normal execution is not activation. Its independent acceptance does not
cover cardinality or later selectors. Serving exposure and authoring remain closed.

## C015 cardinality: original local invariants, not authoring

Five variants × success/counterexample execute the original `resolveSelector`:
exactlyOne, explicitOccurrenceZero, allExpectedCount, ambiguous and missing.
Exactly two archived exactly-one candidates migrate; their fixtures and original
historical assertions remain available in fresh owned historical profiles. There
is no duplicate candidate credit. These ten **local** keys do not close additional
read variants. Independent accepted accounting remains228 pending C015 review.

A separate Node-only fixture generator authors typed provider/model facts, raw
paths/digests, styled Unicode fragments, original UTF-16 spans, explicit scopes
and ordered candidates. Omitted cardinality still means exactly one; occurrence
zero selects the first actual match, out-of-range occurrence retains the honest
actual count, and explicit all must agree with the complete candidate count.
Supported exactly-N is preserved. Paragraph/chip/gap/tab barriers, logical RTL
order, supplementary scalars and explicit NFC/simple-fold neighbors are checked.

Native inspection authenticates the source and creates its real stored snapshot.
The immutable original local capture invokes the original private store getter
and production selector; its UUID, sequence, full model digest, arguments and
result/error are independently joined to inspection, private native access,
closed authenticated GETs and file-backed SQLite. The pure resolver itself is
not an authentication API. A verified second principal on the same thread/original
snapshot is denied by native access and the private store; owner recovery and
599999/600000 expiry complement, rather than replace, local cardinality checks.

Closed native schema companions distinguish malformed cardinality from local
scope/scalar/budget refusals. Actual run65536/65537, NFC16384/16385, scan262144/262145
and candidate48000 boundaries retain valid/refused/repeated/recovery neighbors.
A query may report500 matches while returning one; a complete selector cannot
use that truncation as exact cardinality, and its candidate-byte cap intervenes
before a full500-candidate result. The query501 control reaches the match cap.
Inspection is allowed to persist its snapshot; selection preserves exact snapshot
state without durable read-work/cursor/delivery/pin or authoring/read authority.

Each normal key has a matched positive and a passing child with an actual altered
production selector behavior, rejected at the exact first independent parent
comparison. Timeouts/setup errors earn no fault credit. C012/C013 and the reviewed
Greek simple-fold correction remain unchanged. S02 is incomplete.

## Independent assertions and remaining E work

Fixtures are original inert provider and expected-result data. No production
parser/projection/helper generated their expected nodes, text, offsets, omissions,
provenance, coverage or negative results. Setup GET responses and actual models
are read evidence; there is no invented post-mutation readback. Assertions compare
parsed native args and output, verified subject/thread/view/revision, exact HTTP
methods/URLs, original provider state, actual model facts and persisted delivery
token/read ID/scope/node/aspect/omission state. The test adapter has no mutation or
asset route. A transport fault remains fatal even if application code catches it.

Other implemented A/B/C source behaviors do **not** gain adapter credit by sharing
a tool name. E must add their exact variant discrimination and independent
fixtures/comparisons to this same executable registry, including all remaining
read/internal outcomes. Source schemas are present, but only the fifty-nine
explicit D/E adapter variants have execution routes. No blanket S02
implementation or delivery claim follows from this bridge. Future writers,
Markdown/HTML, regex and later selectors remain closed.

For actual delivery candidates, retain this recorder and intake; join the normal
fixture index and explicit operation registry, then run the unchanged
`auditEvidence` sibling/dependency/closure/external gates. Candidate-only tags and
`bridge-cases.json` never set `deliveryOverrides`. E must deliberately move an
exact reviewed case out of the supplemental index and use `@bridgeExecution`
instead of `@bridgeCandidate` before delivery; do not shadow
an existing fixture ID or relabel these bounded cases as 367 outcomes. Serving
wiring/exposure and applied-code observation remain separate reviewed tasks.
