# Docs acceptance foundation (S00/S01)

Run `npm run test:docs` for the source-level Cucumber profile. `npm test` builds
Drive and the sibling Calendar plugin, runs both OAuth and Docs profiles, and
then the Node suites. No future/pending scenarios are counted as implemented.

`support/world.mjs` has no import-time test registration or host/network setup.
Each scenario explicitly creates real formatting/replacement services, the real
Google/Docs adapters, and SDK-host-owned disposable **file-backed SQLite**.
HTTP is a closed allowlist with independently authored request/response vectors;
unexpected calls and malformed mutation bodies fail teardown even if the service
catches their exceptions. SQLite restart closes/reopens the same database and
recreates the services. Clock changes and promise barriers replace timing sleeps.
No connected provider, real document, settings or plugin installation is used.
Asset scenarios inject separate DNS/HTTPS transports into the real URL/SSRF/PNG
validator; assets never use a global fetch stub. This is not a general Google
emulator or semantic-engine World.

## Submission facts (formatting)

| Boundary | Saved state | Claim | Evidence |
| --- | --- | --- | --- |
| Preflight or adapter final-gate refusal | `not_submitted` | released | saved attempt false |
| Dispatched definitive 400/403 rejection | `rejected` | released | saved attempt true, no acknowledgement |
| Response loss after dispatch invocation | `uncertain` | retained | saved attempt true, no acknowledgement |
| Acknowledged POST, failed metadata/Docs readback | `uncertain` | retained | saved attempt true and acknowledged revision |
| Acknowledgement plus persistent receipt-storage failure | prior durable `writing` intent | retained | acknowledgement may exist only in this call's memory |
| Process loss after intent, before known dispatch | `writing` | retained | intent alone does not establish an attempt |

`writeAttempted:false` on **status/repeated-key calls** means that call does not
mutate Google. For compatibility, the legacy immediate `rejected` result also
retains `writeAttempted:false` (not accepted); it does **not** mean no POST was
invoked. The additive `historicalWriteAttempted` reports execution evidence known
to this result: boolean when known, `null` for legacy/missing evidence. After
restart, only persisted evidence is available. It is not proof of bytes arriving
at Google. Old receipts are not backfilled. Existing
`providerAcknowledged`/`appliedRevisionId` remain independent facts and are never
cleared by failed reads. A definitive read rejection is not a write rejection.

Read-only recovery can verify an already acknowledged matching revision under
the existing contract; matching content without saved acknowledgement is only an
observation and keeps the claim. Storage failure cannot fabricate an
acknowledgement after restart. No status path retries a write or rolls it back.

## Bounded local final checks, not atomic serialization

Formatting/replacement adapters now run the application callback **after** their
final asynchronous identity/scope check. The callback observes the connected
subject, the existing formatting claim (or replacement's existing image
interlock), and standing-consent policy. Cancellation, and formatting expiry,
are checked after all callback awaits. Transport checks cancellation again before
its single dispatch. Barriers cover final auth, claim reads, policy reads and
return from durable-intent persistence.

These are ordered observations, **not an atomic account/policy/claim epoch**.
An account/claim may change during a later policy await; an asynchronous policy
port may return an earlier captured value. The Node limitation witnesses
explicitly demonstrate that captured-policy race still permits a POST. Even the
expiry observation cannot lock time across the callback's promise continuation.
Remote revocation and concurrent Google edits remain governed by provider auth
and required-revision CAS. A supported, serialized local authority/dispatch
protocol is later work, not asserted by these tests. The current composition
passes async settings callbacks and supplies no such epoch/dispatch port.

Replacement still has **no own durable key, claim or operation TTL**. It does
not gain cross-call idempotency or formatting exclusion here. Approval remains
owner-controlled for requested formatting and replacements, including deletion;
turning it off does not manufacture an owner submission. Existing image,
creation, upload, sharing, filing and Sheets policies are unchanged.

Offline fixtures establish these local contracts, not Google availability,
font rendering, live BB delivery or visual approval-card behavior.
