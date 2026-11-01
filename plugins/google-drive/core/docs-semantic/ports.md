# Semantic read ports (S02)

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
