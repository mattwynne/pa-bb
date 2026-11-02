# Local legacy-writer coordination foundation (unscored)

This is **not a semantic executor**, AuthorityDispatch, public operation tool or
full S03 gate. No semantic dispatcher/seal/approval path exists in this tranche.
Existing writers keep their own transport/authentication and verification
contracts; their callbacks are not relabelled K5. No provider action or activation
is authorized by source/tests.

## Core and technical port

`writer-coordination.mjs` owns fixed resource roles, conflicts, retained legacy
projection, closed new observations and release/hold decisions. Provider IDs are
cross-account resources; namespace+key identifies an owner. Same UUID in another
historical namespace never delegates ownership.

- contentWrite conflicts with other contentWrite/accessMutation on the same ID.
- accessStable conflicts with accessMutation on the exact ID; ancestry readers
  do not exclude one another. Copy reads its source access, not source content.
- accessMutation covers the exact moved/shared file. Folder creation does not
  content-lock its parent. uploadName preserves destination/name-resource overlap.
- Actual inspected context IDs are retained; absent ancestry is NOT fabricated
  from root or from filing's ownership/My-Drive eligibility rules.

`writer-coordination-store.mjs` implements synchronous local transactions:
`acquire` (including the exact existing legacy SQL transition), `start`, `fact`,
`returned` and read-only inspection. Adapter-private callbacks contain only local
SQL; no async transaction closure or network call is accepted from the core.
Sorted resource acquisition is all-or-nothing. Event history and initial owner
identity are immutable; every load replays the closed events and compares the
current projection, not just its self-checksum. The immutable genesis commits the
full initial ID/role/grant-kind set, including every inspected ancestry right.
Successful later attachments append a closed full-set `grants` fact. Core and SQL
use the same binary order (including mixed-case provider IDs). Every catalog read,
admission, start and coordination mutation verifies exact physical rights against
that history in a synchronous SQLite snapshot; missing/extra/misbound/orphan
rights fail closed, never reconstruct grants or erase an unknown hold. A genuine
terminal fact derives an empty current set and deletes the physical grants; its
historical initial/attachment commitments remain intact. Records lacking a grant
commitment fail closed rather than being inferred from mutable resource rows.
Full initial/attachment facts must fit the existing 4 KiB bound before committing
rights; no schema/migration rewrite or limit increase is used. Blocked attachment
keeps the prior committed set plus the acknowledged/observed known-ID blocker,
not a fictitious exclusive grant. Native finish/stop load and check the exact
subject inside the mutation transaction, including before terminal early return.

Migration 11 appends owner/event/resource tables and reciprocal replacement-key
INSERT guards. The original migrations 0–10 stay byte-identical. The new SQL uses
frozen namespace inputs independently of future runtime participants. Existing
legacy rows, marker names and acknowledgement omissions are never rewritten or
backfilled by migration.

## Real integrated paths

- Unkeyed replacement allocates a distinct internal globally checked
  `legacyReplacement` owner after consent and before its existing fresh read.
  Preview remains claim-free. It persists intent, validated response ID/revision
  and exact text-only verification facts around the existing writer. Unknown or
  acknowledgement/readback failure stays held across reopen. Private
  `inspectReplacement` observes saved all-tab text digests and current revision;
  it never writes, infers acknowledgement, resumes or releases. No new tool or
  public result key was introduced, and historical unrecorded replacements are
  not assigned invented receipts.
- Formatting/image claim/start/update acquire content ownership and append
  explicit newly validated ack/verification facts from their actual executing
  service paths. Their status callbacks do not release a new unresolved hold.
  The original mutual exclusion and legacy output conventions remain intact.
- Private and shared native Docs/Sheets creation retain the original durable-ID
  save boundary, acquire destination context stability and record actual returned
  creation acknowledgement before population. Blocked ID attachment commits that
  fact and stops population; late observed ID is not an acknowledgement.
  `legacyVerified` marks only the actual legacy route's existing successful
  executing verification, not semantic populate/CAS parity. Population's full
  per-stage acknowledgement protocol remains future work.
- Sharing, move/folder/task-child, existing Sheets edit and creation/upload
  access claim/start seams consult the new resources and relevant old rows.
  Copy reservation checks actual known source/destination stability; retained
  copy rows participate in reciprocal admission. Upload ACK/observed-ID updates
  now remain durable even if access attachment returns false.

Known held creation IDs/observations are blockers even if an exclusive returned-ID
grant could not be acquired. A failed attachment does not steal the existing
owner. Existing owners recheck at implemented claim/start boundaries. Their
remaining legacy async final-callback windows are **not** claimed closed.

Retained active rows without sidecars still matter: SQL state is authoritative
where it intentionally differs from JSON, private creation created/incomplete/
verification_unavailable/reserved/uncertain and shared incomplete-after-create
remain exclusion evidence. Relevant corrupt/unknown records fail closed, not
cleanup. The limited legacy claim-store envelope may omit an outcome while its
known claimState is authoritative; this does not create an acknowledgement.

## Budget / retention

Coordination v1: 1024 retained owners, 8 MiB aggregate charged metadata, 64 KiB
initial/current owner record, 4 KiB/event, 16 events/owner, 32 resource roles.
Each held owner reserves 256 KiB before provider invocation for worst-case bounded
records/events/resources; unused credit is released only on a conclusive normal
terminal transition. Thus at most 32 fully reserved owners fit before retained
completed metadata is considered. Facts/history are not TTL-collected to admit
new work. A future created ID reserves two role slots during initial native
admission. Legacy candidate reads are row/byte bounded and stream through SQL.
Encoded accounting is not a heap or physical SQLite file-size guarantee.

A response ID and ack/observed event survive resource conflicts, resource-budget
refusal and a failed nested attachment transaction. If response fact storage
itself fails, prior durable unknown/held remains; no population follows. Pending
known-ID facts continue to block admission even without a resource-row grant.

## Remaining safety gates before semantic execution

Complete actual ancestry/marker association (including unknown-created-ID races),
all participant-specific durable submission/population/copy/upload/Sheets facts,
final synchronous K5 authority/policy/cancel/hash ownership gate and prepared
once-only transport, immutable seal/current-head integration, exact approval and
native handler, full semantic before/readback evidence retention beyond ordinary
30-minute pins, and real process-death proofs are still required. Full legacy
provider recovery/version dispatch and all S03 composition/outcome closure remain
open. Do not execute a semantic batch using a partial test composition or claim
these local guards lock other Google clients.

Actual draft SQL captures now include all three coordination tables: an unsealed
draft must create no execution owner/event/resource; where a test invokes a real
legacy formatting claimant, only that exact legacy owner and its two grants are
permitted. No static `claim:none` field substitutes for this observation.
