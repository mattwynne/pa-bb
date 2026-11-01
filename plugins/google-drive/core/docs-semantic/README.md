# Semantic read foundation (S02, incomplete)

These are original read-only source modules. **S02 is not complete and the three
new tool names are not registered by `server.ts`.** The offline native host uses
the production registration/schema seam directly. Existing public read and write
tools are unchanged. Do not activate this seam merely because its focused tests
pass.

- `model.mjs`: immutable subject/account/thread/document/view bindings; native
  revision provenance; ordered recursive tabs and explicit segments; rich blocks,
  inline nodes, nested cells and physical-span grid; outline and scoped review
  anchors; exact bounded provider evidence and unknown-field digests.
- `selectors.mjs`: explicit tab scope and URL conflict checks; snapshot handles,
  inclusive sibling spans, heading paths/sections; cross-style literal matching
  with paragraph/chip boundaries. Typography maps the listed smart quotes and
  dash variants and collapses Unicode horizontal spaces. NFC is explicit.
  Simple case folding does not expand scalars; results report runtime Unicode
  version. Source maps reject partial normalized boundaries.
- `reader.mjs`: structured node records or text, annotation/omission losses and
  bounded continuation. Structured children are handles, not text placeholders.
  An indivisible record beyond the output budget is refused, not truncated.
- `application.mjs`: inspect/read/find use cases, explicit review-denial fallback
  policy and exact page delivery tokens. Non-native kind detection is metadata
  only, not a file codec. No write probe.
- `snapshot-policy.mjs`, `failures.mjs`, [ports.md](ports.md): core-owned lifecycle,
  model/delivery/cursor/work/pin validation, safe failure meaning and narrow
  external contracts. SQLite retains atomicity/compression/accounting; the HTTP
  adapter performs one requested bounded observation.
- `coverage.mjs`: scope/aspect footprints, exact preimages, original-content
  preview comparison and delivered-node evidence. Read evidence is **not**
  authoring authority. Narrow induced-effect/cardinality proof is explicitly
  unfinished; no generated-node execution protocol is supplied here.
- `../../adapters/docs-semantic*.mjs`: native full-document reads and additive
  SQLite snapshots, compressed provider blobs, cursors and bounded pins. No
  claims, legacy receipt migration, authoring requests or retries are added.

## Foundation identity and evidence rules

Advertised tab ordinals are snapshot-wide preorder positions, including nested
children. The provider's sibling index is retained separately as `siblingIndex`;
it is not an ordinal selector. No scope defaults to the first tab.

Known physical extents must be contained by every known ancestor, and sibling
rows, cells and blocks must not overlap or reverse. Gaps for table/cell structural
delimiters and final newlines are legal; equal adjacent boundaries are legal.
Visual row/column spans alias one physical cell: they do not duplicate its content
range into later rows. Missing ends remain unresolved, not inferred from children.
The snapshot-wide unresolved summary is diagnostic only; native revision/view
provenance stays separate from scoped mapped completeness. Witness evaluation
checks targets, declared dependencies and necessary ancestors, plus unresolved
nodes whose conservative enclosing scope might intersect the footprint. Different
tabs/segments and provably disjoint bounded ranges do not veto mapped evidence.
Known partial starts, descendant boundaries, ancestor bounds and physical sibling
order are checked jointly before materialization and again at witness entry.
Internally contradictory provider facts are rejected with a safe extent error;
a missing end cannot hide a backwards start or a descendant outside its parent's
known lower bound. Temporary constraint summaries never become inferred ends.
An unresolved target/ancestor/dependency or unprovably overlapping range still
refuses, even with an exact original preview. No child coordinates are invented.
Zero-width and segment-wide targets conservatively require mapped scope in their
own context; this is not a future effect planner.

Review fields are read at their actual table/row/cell (and block) schema locations.
Receipts carry per-node delivered aspects. The page-wide aspect list is only the
intersection, not proof that a `review:true` option delivered an unknown shape.
Unprojected fields on recognized nodes produce scoped losses and no aspect credit
for those nodes. Internally retained bytes/digests are not delivery. Disjoint nodes
can still satisfy their own footprints; a complete exact-original preview can
cover omitted unknown fields. This does not implement later mutation support.
Footprints require nonempty unique legal aspects; destructive footprints require
content and their complete target-descendant/dependency set, revalidated at the
evaluator boundary. No caller completeness flag can bypass those checks.

## Bounds and lifetimes

Provider JSON: 8 MiB; bounded-tree traversal: 100,000 values/nodes and depth 32;
semantic nodes: 100,000. Dense topology is capped at **100,000 aggregate grid
slots across all tables**, checked before any grid allocation, with safe-integer
dimensions/spans. A separate **32 MiB conservative derived-model reservation**
charges repeated values, identifiers, paths, styles, review references and topology
before expansion. The reservation can refuse a document whose eventual JSON would
be smaller; it is an implementation bound, not a Google limitation or a V8 heap
size promise. Final measurement and storage checks are additional defenses, not
the allocation guard. JSON byte measurement avoids a full serialization copy;
provider-tree pending work is bounded before pushing child lists.
Review-anchor intersection work is capped at one million comparisons. Serialized output: 64 KiB, with indivisible oversized records refused.
The persisted pool accounts for uncompressed evidence/model/cursor/delivery bytes
and is capped at 32 MiB; four snapshots per subject/thread. Snapshots expire ten
minutes after retrieval; cursors expire after five minutes or at snapshot expiry,
whichever comes first. A cursor is consumed transactionally and cannot change
scope, document, view or projection. Failed cursor use does not authorize replay.

Native page packing measures the complete public response, persisted delivery and
continuation state with the actual pre-generated bounded receipt/cursor tokens
(1–128 ASCII characters; default UUIDs). Record, loss, node-ID and node-aspect
container sizes are accumulated once; small envelope shapes are cached. The
complete remaining candidate is checked before greedy prefixes: completion can
shrink the response by replacing a long cursor with null, including after the
last omission-only loss. This transition is not assumed to be monotone. No fixed
metadata reserve or growing repeated serialization is used. All size checks occur
before the atomic receipt/cursor commit. A record and its associated loss evidence
are indivisible; oversized units are explicitly refused. Omission-only losses use
a separate saved offset and can occupy loss-only pages, without acquiring content
credit. Completion means both records and losses have been drained.

Pins retain evidence for an explicit deadline of at most thirty minutes, without
extending ordinary read/selection authority. At most 32 pin owners per snapshot.
Expired evidence is collected lazily during insertion or explicit sweep. No
uncertain mutation evidence is stored or garbage-collected by this module.

## Remaining S02 gates

Of **367 S02 outcome keys / 95 variants**, 238 have historical independent
acceptance and 129 remain; four supplemental candidates are separate. Read
closures are 42/59; serving exposure remains zero. The [test path](../../features/docs/testing.md)
records actual core/application, adapter and mandatory native/SQLite companion
execution without promoting counts merely because setup changes. Required work includes:

1. Complete the rich/opaque/style/registry projections and loss evidence across
   every assigned variant, including exhaustive section/span and normalization
   boundaries and exact resource limits.
2. Complete the K3 read-witness interfaces and independent tests without inventing
   downstream planner/executor/approval success. Generated-stage protocols remain
   S03 work; their needed pure evidence interfaces are not complete here.
3. Extend existing fixed product-intake executors, schema/variant inventory joins,
   independent outcome fixtures and concrete ledger Examples to the remaining
   keys. Keep counterfeit absent-driver/missing-companion tests and all S01
   protections; application evidence never stands in for native invocation,
   durable storage or a live provider result.
4. Close every exposed variant's sibling and dependency outcomes, including
   C009, before wiring the read registration into the server factory.
5. Independent review, supported activation under a fresh writer quiet window,
   applied-code verification and scoped delivery remain separate gates.

Markdown/HTML projections remain S12; regex remains C014's later slice; table and
named-range selectors remain in their assigned slices. This list does not reduce
the full approved program or convert engineering gaps into provider limitations.
