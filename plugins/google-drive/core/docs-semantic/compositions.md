# Closed atomic paragraph composition (unregistered)

This engineering path supports the existing paragraph-bold/1 and literal paragraph-replace/1,/2 effects on **disjoint original body paragraphs**, in one subject/account/thread/document/snapshot/direct mode. A document may contain multiple tabs. It is not generated content, table/cell geometry, collaboration, suggest mode, Office, richer styling, font rendering, public registration or end-user delivery.

## K2 inputs and replay

The unregistered factory exports actual `docs_plan_style`, `docs_plan_content`, `docs_plan_combine`, `docs_draft_status`, `docs_draft_cancel`, `docs_apply` definitions. Serving `server.ts` and `app.tsx` do not import/register them.

Style uses the strict K2 FamilyInput envelope:

```json
{"account":"writer@example.test","draft":{"kind":"new","requestId":"wording","destination":{"snapshotId":"snapshot"},"mode":"direct"},"commands":[{"op":"text","target":{"node":"snapshot:7"},"set":{"bold":true}}]}
```

Content uses that same envelope with closed `{op:"replace",target:{node},oldText,newText}` commands. Extension replaces `draft` with `{kind:"extend",draftId,expectedDraftHash}`; it can add the other family. Combine accepts exactly `{account,requestId,inputs:[{draftId,expectedDraftHash},...]}` with ordered 2–16 unique inputs. Only already-resolved nodes are admitted; refs/cells/creation destinations/sources, unknown operations/fields/modes are rejected, not coerced.

A NEW request is bound to canonical **family plus complete input**, subject and originating thread, before planning. Server generates its UUID and checks every retained key namespace. Rejected planning consumes its reservation and requestId, retaining its exact no-write result. Combine is different: it has **no eager reservation**; failed combine leaves no new key/pin/head/result/input consumption.

Identical NEW/COMBINE requestId repeats return the **ORIGINAL persisted call result/revision**, including original expiry, not a recomputed result or a later extended head. The exact result has its own closed immutable artifact in the existing revision table; its bytes count toward existing limits. Successful combine replay is resolved before inspecting the now-superseded inputs. Changed canonical input, including input reordering, conflicts. `docs_draft_status` separately returns CURRENT head/lifecycle. A historical returned hash is not fresh Apply authority. Stale Apply is rejected locally before provider access.

Extension uses a real CAS head and appends immutable plan revisions. It never changes the initial request identity/result or deadline. The new draft record (`version:2`, explicit `paragraph-composition/1` profile) has a lifetime anchor; combined creation time is NOT that anchor. Combine inherits the earliest input deadline. Old draft-v1 decoding/expiry semantics are unchanged. Superseded inputs use a separate closed version-3 wrapper retaining the exact prior receipt and original plan blobs, not a fabricated cancellation. Their link must identify the actual combining request/input head. No sealed/submitted/uncertain input is consumed.

## Evidence, expiry and limits

The closed composition plan is version 1 with kind `paragraphComposition` and capability `paragraph-composition/1`. Its parts retain ordered source provenance, command, original node/path, exact effect, capability and verification contract. One RAW body/named-style witness is shared per replacement-containing body; bold targets in that body reference the same RAW witness. Bold-only bodies need only their actual selected RAW paragraphs. This avoids storing repeated full-body scalar plans. Bounded scalar codecs can be reconstructed, never arbitrary request objects or hash-only source authority.

The conservative logical-command limit is 8. The 2–16 combine-input syntax does not promise that every such set fits that command/card/storage budget. Every plan/record/revision artifact must still fit 65,536 bytes; the complete ordered review must fit 48,000 bytes. No truncation, omitted command, pool eviction, larger heap or limit relaxation. Draft pool 8 MiB/1,024 records and existing evidence/journal/writer/future-credit/runtime bounds remain unchanged. Persisted original-result artifacts are fully charged, not free storage.

New target coverage (including extension) requires the original ordinary ten-minute snapshot to remain live. Combine may use the already-closed, individually pinned source footprints after ordinary snapshot expiry, but only within their existing deadlines. Its new pin inherits that deadline, never renews the inputs or expands coverage. One synchronous SQLite transaction rechecks every owner/head/seal/expiry, source footprint, budget/global key, then inserts the new key/pin/head/result and supersedes ALL inputs. Any failure rolls back every row, including partial input updates. Existing migration bytes 0–13 and immutable-revision/sealed-head triggers remain intact.

History and authority are separate. Ordinary expiry/sweep can collect an unsealed snapshot/pins without deleting its immutable RAW plan witnesses, result, revisions or key tombstone. Those closed witnesses and actual immutable ancestry still validate metadata/original-result recovery; they are **not fresh planning/apply authority**. If an executed root retains its before model, that validated ROOT source is passed through ancestor checks: superseded ancestors do not need transient pins of their own. Corrupt available evidence/lineage/ref/response still refuses; no status pin renewal or repair. A decode-local memo only deduplicates already checked data inside one synchronous SQL view, never across provider awaits or database cuts.

## Compilation and independent verification

Intention/provenance order stays sealed. Compiler schedules WHOLE disjoint command blocks descending by original index within each tab. A replacement's delete/insert/explicit-seven-style triplet retains its internal order; individual requests are never globally sorted. Earlier length changes therefore shift already-edited later paragraphs naturally. No original target is reinterpreted as a later ordinal.

The separate verifier resolves each original node in the actual Reader graph. It independently derives scalar-safe literal differences, inserted known style, per-body UTF-16 delta sums and allowed bold changes. It checks every affected/untouched paragraph/run extent and piece, then compares the remaining WHOLE RAW document after masking only independently proved effects. It does not compare against compiler/reducer output or return the first scalar comparator success. Other tabs, segments, registries, review fields, unknown/unlisted fields and original newlines stay protected. Only the selected existing scalar profiles' exact normalizations apply; default weight 400 is not generic RGB/font/rendering permission.

## One-stage execution, exact consent, zero-write K6

The existing K5 epoch/claim/seal/intent/synchronous-one-use-dispatch pipeline executes ONE required-revision batch. A closed program shape derives expected reply count from every command's actual minimal requests; callers cannot select a count/verifier. Existing runtime-v2 factual meanings remain unchanged. Own durable ACK precedes readback. The whole program plus preservation must match at its OWN acknowledged revision and acceptable save state before release. Unknown/lost reply, ACK persistence failure, drift, unavailable readback or unresolved save stays held. No artificial stages, partial-held credit, retry/replay/repair or second executor.

The mixed renderer payload is a strict complete ordered card, with account/document/title/revision/head/expiry, all provenance and exact before/after paragraph/literal/style/UTF-16 witnesses. One approval covers the entire program. Enabled Docs approval requests real owner input; disabled approval records standing_content_consent, never owner_approved. No separate destructive gate is invented for these ordinary direct-content effects. The isolated source app/SSR/frontend compilation are engineering evidence only: rendered BB desktop/narrow/keyboard/deferred review and delivery remain UNVERIFIED until separately authorized.

K6 recognizes the new saved draft/wrapper/closed family through validated local lineage and existing runtime/header/response/ref graph. Draft version 2 is distinct from execution runtime 2. Superseded inputs remain metadata/key history, not new execution controls. Current observation uses the independent closed verifier and cached-valid-token userinfo/metadata/document GETs only. No refresh, cache/email writes, claims/pins/receipts/events, repair/release/replay. A current match never supplies an ACK or changes historical facts; own-r2 versus identical-body foreign-r3 is separate.

A real multistage successor is table insertion → fresh independently verified generated binding → population. It still needs actual table planner/compiler/topology/binding persistence and a stage kernel retaining aggregate claims/revisions. This atomic paragraph unit does not deliver those dependencies, whole S03/S04, exposure or acceptance-key credit.
