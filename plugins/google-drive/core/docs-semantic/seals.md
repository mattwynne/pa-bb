# Private first-bold seal (not editing readiness)

`createBoldSealService({store,docs,clock,diagnose})` exposes private `sealBold`,
read-only `status` and `cancelNotSent`, all keyed by the SAME already reserved
`{operationId,planHash}`. No new tool, approval decision, transport POST, dispatcher
or exposure/delivery credit is provided by this seal-only API. The separate
unregistered [first native execution candidate](executions.md) uses fresh atomic
`sealForApply` ownership; it never resumes a seal-only record.

## Production path and ordinary-existing-Doc policy

The application loads the real immutable saved `paragraphBold/1` plan and exact
full pinned model, obtains the actual target-context observations internally,
then performs a fresh complete inline/review Docs GET. The original subject-bound
editable revision and all initial evidence must still match; no new revision,
range, target or plan is substituted. Current account/head/deadline/pin/signal
checks surround awaited boundaries. Drive version is not Docs revision proof.

One short synchronous SQLite transaction re-reads current account, original head
and full model, derives rights from the observed complete concrete ancestry, and
captures/re-decodes current raw coordination/legacy/marker facts. It atomically
publishes the execution header, not-sent stage, PENDING approval intent, full
execution evidence reference/future credit and genuine `semantic` coordinator.
Any failure, including after an insertion, rolls everything back. Header plus
head guard seals the existing immutable revision; it is not a second operation.

An ordinary unmarked Doc with supported complete ancestry is permitted under the
reviewed local-exclusion policy; its origin remains **unresolved**, not safe or
certified. Unknowable external history is neither reconstructed nor a permanent
ban. Shared-drive boundary incompleteness still refuses this first seal. No
filing ownership restriction, global root content lock or unknown-target fallback
is introduced. Provider observations and the local transaction are not remotely
atomic or a permanent permission grant.

Known unresolved **RESULT/birth** IDs matching the target or actual ancestors are
checked separately from resource roles. A copy's unresolved result blocks seal
although accessStable is content-role-compatible; sourceId/common destination
are not result IDs and do not prohibit source-content work. A folder result can
be an ancestor birth obligation. Modern held created/observed IDs dominate weaker
legacy verified presentation even without an exclusive target grant. Pending,
missing or incompatible producer associations and malformed positive copy-binding
facts fail closed. Historical completion retains only its original legacy scope.

Real old claim/start/returned-ID gates consult the semantic coordinator through
the existing reciprocal resource policy. Late native Docs IDs save ACK before
failed attachment and stop population. The separate native intent protocol re-captures
late known-ID/result/marker obligations; a seal alone never permits submission.

## Retained full evidence and finite accounting

Migration12 appends `docs_semantic_execution` and `docs_semantic_execution_refs`;
statements0–11 are unchanged. The coordinator's immutable genesis commits the
actual header digest and exact initial rights. Header/record/reference/key/head,
full model, raw evidence, row bindings and digests are checked on recovery.

Execution references retain BOTH existing lossless provider evidence and the
actual full model, not a paragraph fragment. Source/model logical size is bounded
at 1MiB for this first seal. Future raw readback is bounded at 1MiB and a reply at
16KiB; `2*1MiB+64KiB` future physical/logical/fact credit is precharged to the
existing 32MiB evidence pool. Actual source bytes remain charged once, including
compressed storage; reference metadata is charged too. Existing writer metadata
limits/256KiB per held owner also cover the execution header/record. No cap rises,
hidden files, eviction, uncertainty TTL or ordinary snapshot authority extension.

Sweep retains execution-referenced models/raw blobs after ordinary snapshot,
draft and pin expiry. A retained header also protects its source if its reference
is corrupt/missing; recovery refuses corruption rather than erasing history.
Ordinary get/planning/readPinned still expire. The narrow execution-owned evidence
read authorizes only that original owner/head's retained model, not new coverage.
This seal-only tranche conservatively retains evidence AND future credit after
known-no-effect cancellation; no implicit history cleanup is designed here.
Isolated historical snapshot stores without migration12 retain their old contract;
execution retention itself requires the new schema and has no fallback.

## Safe lifecycle/projection

Initial facts are exactly one stage `not_sent`, `intentPersisted:false`,
`verification:not_run`, and `approvalIntent:pending` (NOT consent). Linked draft
status, duplicate planning and catalog project the single seal/claim, never a
second ambiguous operation or the old claim:none/notImplemented view. Corrupt
retained seals report unsupported retained state, not an unsealed draft.

Ordinary draft cancel refuses a sealed head. Private cancellation requires exact
subject/account/origin thread/head and current semantic ownership, no intent,
ACK, prior effect or known IDs, and all stages conclusively not_sent. It retains
immutable key/head/evidence and atomically releases only its own grants. Unknown,
partial or corrupt evidence never becomes a release. Generic writer start/fact
and legacy completion APIs cannot advance or release the semantic owner.

The separate native candidate implements consent, K5's prepared once-only fetch,
durable intent/ACK-before-GET, own-ACK-revision verification and closed process-death
proofs; see [its boundaries](executions.md). That does not enable this seal-only API
to dispatch or establish rendered/runtime/provider/activation acceptance. No
larger quota or implicit migration/backfill is introduced.
