# Semantic read ports (S02)

The separate [no-write draft contract](drafts.md) describes the unregistered
internal S03 engineering tranche; it does not change these read contracts.

The application owns these synchronous/asynchronous contracts. Existing object
shapes remain injection seams; no BB, HTTP or database type crosses inward.
Credentials in account records are opaque provider handles, never model fields.

- `store.byEmail(account)` is awaited; absent accounts return null. Authority is
  checked via awaited `docs.authority(record)`, then the subject is re-resolved.
  Removal or subject change fails before snapshot publication. Authority adapters
  own authentication protocol, not document semantics.
- `docs.metadata(record,id,signal)` returns bounded provider metadata.
  `docs.read(record,id,view,signal,{includeReview})` performs **one** requested
  observation and returns `{document,responseDigest,responseBytes,reviewIncluded}`.
  Failures carry bounded semantic code and optional validated HTTP status. Raw
  content is not a semantic result. The application chooses separate content-only
  observation after an inline review-inclusive 403; other failures do not retry.
- `semanticSnapshots` implements `put/get`, `pageTokens`, `issueCursor`,
  `peekCursor/consumeCursor`, `deliver/deliveries`, `commitPage`, `chargeReadWork`,
  `pin/readPinned/releasePin`, `retainWitness/pinnedWitness`. All are synchronous.
  Owner is `{subject,account,threadId}`. Input aliases cannot mutate saved facts;
  results are immutable copies. No implicit default owner or scope is allowed.
- Ordinary access ends at the exact snapshot deadline; cursors also expire at
  the earlier five-minute deadline. Peek does not consume. Failed `commitPage`
  preserves the original cursor and publishes neither delivery nor successor.
  Successful commit consumes exactly the matched cursor state once. Work charged
  before packing is not refunded by later failure. Pins retain evidence only;
  they never extend ordinary read authority. Witness pin/record publication is
  atomic. Every reference remains owner- and snapshot-bound.
- `clock()` and `ids()` are injected; diagnostics receive fixed stage/category
  only. Unexpected substitute methods fail, not generic success.

`snapshot-policy.mjs` owns lifecycle, topology and delivery interpretation.
Adapters invoke it within atomic operations. SQLite owns migrations, seals,
compression limits, live-data accounting, transactions and cleanup of known
sealed records. Memory substitutes establish logical contracts only, never
physical capacity, tamper resistance, reopen, crash or durability. Real SQLite
and native-schema/registration companions remain independently required.

## Private paragraph-bold target-context observation (not an executor)

`createBoldTargetContextService({store,docs,journal,snapshots,clock,diagnose})`
exposes only `inspectBoldTargetContext(owner,{operationId,planHash},signal)`.
It loads an actual saved current draft and its full original `readPinned` model;
subject, exact saved account, origin thread, state/head/deadline are checked before
I/O, after awaits and at final local capture. Account lookup/authority uses the
saved binding and is re-resolved, never inferred from a caller tuple alone.

- Separate `docs.contextMetadata(record,id,signal)` returns raw
  `{document,responseDigest,responseBytes}` for bounded Drive GETs. S02 metadata
  fields/results/hashes are unchanged. There is no write or widened grant.
- `writers.readTargetContextFacts({resourceIds,markerKeys})` is a synchronous
  **read-only** SQLite cut after provider observations. Inputs derive only from
  core traversal. It returns bounded raw owner/genesis/event/physical-right facts,
  held known IDs without grants, relevant SQL-authoritative legacy rows and exact
  marker candidates with a digest. C1 audit and candidate limits fail closed;
  core interprets conflicts/versions. Cross-subject raw receipts never leave the
  application as public observation data or diagnostics.
- My Drive termination needs an independently resolved concrete root. A root can
  omit parents; an arbitrary parentless folder cannot prove termination. Shared
  drive traversal currently reports its boundary unresolved: this tranche has no
  independent drive-boundary port or new authorization. No filing eligibility or
  ownership restriction is imported into content observation.
- `CONTEXT_LIMITS`: 64KiB per response, 256KiB aggregate responses, 30 ancestor
  edges, 33 metadata calls, 64KiB result, 8MiB raw local-fact budget. Prospective
  actual rights also must fit existing 32-resource/4KiB grants-event/64KiB record
  envelopes before another GET. Unsupported multiple parents/cycles refuse.

The immutable result separates observed/unresolved ancestry, unresolved origin
policy, redacted local blockers and missing execution prerequisites. An unmarked,
non-owned document can have supported ancestry and unresolved origin. Marker
observations never append facts/ACKs/grants. The result is ephemeral: not a lease,
not atomic with Google, not current Docs revision evidence, not valid after return
and not retained execution evidence. No draft/pin/delivery/legacy/coordination row
is modified, and no claim, seal, approval or mutation route exists here.
