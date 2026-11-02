# Internal no-write draft vertical (unscored S03 engineering)

`createDraftService` is **not registered** in BB. No new tool, approval UI,
provider call, execution claim, executor or legacy verifier is provided by ordinary
planning. The separate private [seal kernel](seals.md) now establishes real local
claims and retained full evidence, but still cannot submit any edit. No
manifest delivery/exposure status changes. The complete 268-key S03 gate remains
open; these tests are not outcome acceptance or native invocation evidence.

## Target-context observation

The private `bold-target-context.mjs` application now consumes the actual saved
`paragraphBold/1` draft, its exact live draft pin and original full model. It
observes provider ancestry and raw local coordination facts without changing any
local row or granting execution authority. Ordinary snapshot expiry does not
invalidate a still-live exact draft pin. No new pin/retention authority is added.
See [ports.md](ports.md) for budgets and explicit unresolved origin/shared-boundary
and execution prerequisites. A complete ancestry observation is not a seal.

Real S02 snapshot bindings also contain transport response digest/byte accounting.
`logicalPlanBinding` explicitly projects semantic identity/revision/evidence into
the closed logical plan, leaving that transport accounting on the retained model.
Previously supported binding/hash shapes remain unchanged; actual inspect-origin
models now reach the same planner instead of failing on extra binding fields.
The independent paragraph-bold verifier separately projects observed semantic
identity from the actual before model (not via the planner helper), retaining its
independent command/target/source/dependency and unrelated-content checks.

## Production semantics

The caller supplies a verified `{subject,account,threadId}` through an internal
boundary, as for the S02 read/evidence services. It is not a public input or a
substitute for future live authority checks. Input is a closed direct-mode
command: requestId, destination snapshotId and `{op:'paragraphBold',node,bold}`.
No ranges, resolved plans, requests, expected result or verifier is accepted.

The planner rebuilds/validates the complete S02 model and derives an exact
whole-paragraph target, mapped contiguous text runs, terminating newline,
old/new bold values, dependencies and property/preservation witness. This first
implementation supports body paragraphs directly owned by a segment, known
bold evidence and complete inline/current editor/review evidence. Lists,
review-changing footprints, incomplete/unknown dependencies, inline objects,
table-contained paragraphs, unsupported segments and malformed ranges refuse.
Disjoint opaque material remains supported and must be preserved.

The plan also captures a separate bounded original paragraph evidence/path/digest,
not a caller-provided expected result. Closed cross-field validation binds the
command, target, raw source, exact old/new properties, dependencies/footprint,
versions, lifecycle and canonical request. Publication checks those facts against
the actual S02 snapshot; every saved load/result/catalog repeats logical and
record consistency. Checksums alone never establish these invariants. This is
not protection against arbitrary coherent rewriting of all private history.

The compiler emits one exact tab-scoped updateTextStyle/requiredRevisionId/EDIT
program; it is internal, pure and never submitted. The separate verifier imports
neither planner nor compiler: it independently resolves the sealed command in the
actual before model, checks source/target/property/dependency facts, and masks
only the authorized bold properties when comparing **all other provider fields**.
It safely handles omitted/empty before textStyle containers when inheritance is
known, preserving every unrelated field. It currently requires exact run topology
and explicit observed after-bold values;
run-split/inheritance normalization is not implemented. Its comparison is an
observation, always `attribution:'notEstablished'`, not acknowledgement or native
revision-attributed post-write verification. A future executor must separately
establish submission/acknowledgement and acknowledged-revision provenance.

## Journal port

All methods are synchronous. No transaction callback or network dependency is
exposed to the core. The actual SQLite adapter implements:

- `byRequest(owner,requestId)` and `byId(owner,id)`: immutable saved reservation
  plus exact head plan. RequestId is scoped to originating subject+thread;
  draftId recovery is same-subject and can cross threads. No read/status writes.
- `reserve(record) -> {created,saved}`: atomically bind request/hash/key before
  planning. Identical duplicate returns saved data; changed input conflicts.
  Collision checks include semantic and all six retained legacy operation tables,
  across subjects, all states and tombstones. No private receipt decode is needed
  to reject a key collision. Reciprocal INSERT guards stop existing legacy
  reservation consumers inserting a semantic key; historical legacy-vs-legacy
  collisions are retained, not rewritten. No legacy mutation/claim lifecycle is
  otherwise changed.
- `publish(id,owner,plan,now)`: require planning reservation and origin thread,
  matching canonical command/hash, lifecycle and evidence binding. Admission,
  snapshot pin, immutable revision insert and head publication are one short
  SQLite transaction. A failed pin/revision/head write rolls back the entire
  publication. There are no execution claims.
- `reject(id,owner,category)`: preserve a no-write failed-planning receipt under
  the reserved key/request. If storage cannot save this, the durable planning
  reservation remains discoverable. Repeated plan/status never resumes it or
  issues a replacement key.
- `cancel(id,owner,hash,now)`: origin-thread exact-head cancellation; idempotent,
  retains revision and key. A linked seal refuses ordinary draft cancellation;
  only the seal kernel's exact known-no-effect private cancellation can release
  its own conclusively not-sent claim. Unknown/partial work cannot be released.
- `catalog(owner,{operationId,namespace?})`: bounded same-subject technical rows.
  Core produces namespace-bound handles and metadata-only ambiguity/unsupported
  results, without invoking any provider or legacy verifier. Wrong subject is
  filtered in SQL before JSON decode. Unknown/corrupt/oversize rows remain safe
  unsupported candidates. New draft keys remain UUIDv4; historical formatting/
  sharing lookup and handles retain their actual broader UUID grammar. Legacy
  metadata checks immutable identity/resource/version and known route outcomes,
  preserving missing-kind/hash-only/shared-v1 omissions and SQL-authoritative
  lifecycle differences. Recognition is metadata-only, not proof that every
  legacy recovery prerequisite is present. A recognized candidate is **not
  verified legacy recovery**. Full versioned legacy verifiers remain later work.

Drafts have immutable initial 30-minute deadlines, hash-bound lifecycle and
capability/budget versions, and evidence pins through that deadline. Cursor or
ordinary snapshot expiry does not erase a saved plan. Starting a new plan still
requires a live S02 snapshot. After deadline status is an observation (`expired`)
without cleanup, renewal, continuation or new authority. There is no extension,
combine, approval-decision or dispatch API. Sealing is a separate private path,
not a new planning authority: linked status/duplicate/catalog views expose the
same single semantic operation as sealed/cancelled with its real claim state.

## Admission / persistence boundary

`DRAFT_LIMITS` v1 imposes conservative **local engineering** maxima: 1024 retained
reservations, 8 MiB total encoded draft records+revisions, 64 KiB per record and
64 KiB per plan; the independent existing S02 snapshot/pin budgets also apply.
Total bytes refer to encoded live rows, not physical SQLite file size or heap.
Bounds are checked before publication, and SQL reads project capped receipt/plan
strings before JSON decode. Catalog legacy input is capped at 4 MiB per retained
namespace (at most seven candidates per key), returning only bounded metadata.
No history/tombstone/unknown record is garbage-collected to admit new work.
At capacity no new reservation is created. Storage exhaustion after reservation
can leave recoverable planning state, never a silently reusable key.

Known snapshot/refusal/expiry errors stay distinct from unexpected storage I/O
in both planning and publication. Diagnostics use a nonthrowing external boundary;
a logger failure cannot replace a safe error or interrupt rejection persistence.

The journal appends migration index 10 after all ten existing statements. It
creates only draft/revision tables and targeted key/immutability triggers, and
never rewrites old receipt bytes or marker names. Existing migration prefixes
remain unchanged. All future schema work must append, not alter this SQL tail.
The old tenth and new eleventh SQL hashes are pinned independently of the old
nine-statement fixture. The v1 SQL namespace inputs are frozen separately from
the current catalog registry, so a future registry expansion cannot alter this tail.
The memory journal is a test substitute for logical promises only. Shared
contract cases run against it and real file SQLite; SQL rollback, independent
connections, corrupt rows, migration preservation and reopen have separate real
integration tests. Process death, native dispatch, full legacy recovery and
whole-S03 acceptance remain unproved here.
