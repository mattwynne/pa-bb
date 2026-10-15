# 015 — Continuous iCloud note access

Status: **approved for implementation with a single-user offline update; no overlay shipped**. The first draft received three independent GPT reviews, not the requested multi-family ensemble: explicit Claude/Gemini model selections did not take effect. The user accepted that coverage and authorized continuing with parent approval. The parent corrected and inspected the revised lifecycle below and approved sequential implementation, not production readiness. See the [review record](015-icloud-continuous-note-access-review.md). No second review round completed. The initial updater stop and the owner's subsequent acceptance of an offline, fix-forward update are recorded under [Execution evidence and stop](#execution-evidence-and-stop).

Starting points: [problem and live evidence](../problems/icloud-continuous-note-access.md), [iteration 006](006-obsidian-vault-reading.md), source baseline `1baa405`, and the [pinned rclone v1.75.2 bisync reference](../references/rclone/docs/content/bisync.md). No runtime code, production migration or device test has been delivered by this plan.

## Outcome and scope

Once initialized, a vault remains discoverable and supports useful local reads and prompt, durable local saves during ordinary background sync. Consumers do not poll sync phase, time requests or receive routine sync-busy errors. A 40-second cloud run must not become a 40-second local save.

Local success means durable note bytes and a recoverable logical commit, not an in-memory queue entry or cloud delivery. Sequential supported reads use those bytes immediately. Missing files, storage/capacity failures, initialization, lost ownership and genuine recovery blockers remain real outcomes.

Keep:

- Whole-vault standing read/write after explicit connection, including nested/hidden Markdown; multiple stable vault IDs; no automatic connections.
- Conditional saves, full-note read proofs before edits, bounded parsing/scanning, path/symlink containment, per-note previous versions and durable operation identities.
- Stock recursive bisync, native ownership, numbered conflict preservation, deletion checks, resilient recovery and critical stops. No forced resync or clearing locks/baselines to bypass a failure.
- The distinction between **saved locally, pending iCloud sync**, application to the mirror, a completed native run and independently verified cloud/device bytes.

Do not add folder permissions, read-only switches, per-edit approvals, an editor/browser/graph, whole-folder copies/backups, subfolder partitioning or a second remote reconciliation engine.

## Recommended architecture

Use a bounded, iCloud-owned **per-note durable overlay** outside the native mirror and baseline directories. It is the authoritative local view only while an acknowledged edit is pending, awaiting a following native run, or retained by a conflict. Native bisync remains the only cloud reconciler.

Supported note consumers use coordinated RPC. The native mirror is not advertised as a continuously authoritative filesystem view. Direct OS reads cannot see an unapplied overlay.

### Ownership and scheduling

One generation-owned arbiter controls native commands and mirror application. Preserve the existing inherited `worker.lock` flock; do not substitute an expiring lease or a JavaScript flag. The service-wide exclusion currently supplies serialization that `RcloneProcess.run()` does not enforce by itself: removing it requires this explicit replacement.

A generation acquires actual ownership before accepting overlay publications or performing migration. The current owner may publish overlay bytes while **its own** native child runs; publication does not require native idle. A replacement cannot write the same store while its predecessor or an inherited command child still owns the flock. A surviving RC daemon is not evidence of mirror ownership; preserve existing orphan checks and retirement rules.

The arbiter has separate paths:

1. Short local operations: note reads, durable overlay commits, receipt queries and configuration transactions. Serialize publication per note and quota reservation globally, without awaiting remote work.
2. A single native-command/application queue: at most one command or direct mirror mutation at a time, with the current native generation and file guard held throughout application. Schedule authentication/configuration RC work deliberately too; removing the old global lock must not permit concurrent command/config races.
3. Lifecycle fences: before disposal, close admission, wait for already-entered local publications to finish or resolve their journals, then stop children/release ownership. Candidate startup may remain unavailable until takeover; it must not migrate early or admit a second writer. This exceptional maintenance boundary is not normal sync contention.

Persist the host-verified Obsidian configuration revision and membership. Commit/configuration/removal transactions use a fixed lock order and revalidate the admission epoch at logical publication. Removal revokes **new** operations; no stale-revision publication may commit after revocation. Replies already in flight are not proof of a later commit. Configuration removal cannot acknowledge completion until the iCloud admission barrier has accepted its revision; a lost configuration reply remains an unconfirmed change, not proof of revocation.

Obsidian also needs short serialized state updates for pending IDs/configuration without holding that lock over note RPCs. Queue ordinary concurrent mutations rather than leaking its existing global `busy` flag as a new bottleneck. Scope complete-read proofs to the affected path/version/configuration: an unrelated save must not erase another note's valid proof, while removal/configuration changes still revoke affected access. Test overlapping different-note writes and same-note CAS rather than relying only on sequential calls.

An edit acknowledged before Obsidian removal remains a completed local edit. Removal does not undo it: background application may continue for its original enabled iCloud mirror/account, just as an already-written native file would continue syncing today. Application validates mirror/account/baseline identity and ownership, not an obsolete consumer revision. Removing a consumer grants no further reads or writes. A retained/rebuilt mirror is different: never retarget its pending edits to a replacement ID.

### Durable records and version identity

Use one scoped durable index with transactions and immutable per-note blobs; a SQLite transaction with fully durable commit is the recommended index. Respect BB's scoped storage APIs. Files live in private 0700 directories with 0600 contents outside `mirrors/` and `baselines/`. Fsync content and parent directory **before** committing a pointer that can acknowledge success. Startup validates referenced content.

Persist, at minimum:

| Record | Purpose |
| --- | --- |
| Generation | Mirror/path, sequence, parent sequence, immutable blob/hash, operation ID/request digest, admission epoch and local receipt |
| Active head | The current logical generation, or no overlay authority |
| Original base | First external mirror observation: absence or exact bytes/hash plus validated file identity/stat evidence |
| Last applied checkpoint | Separately proved mirror generation, destination inode/hash and application journal; advances after each owned application |
| Run eligibility | The applied generation present before a particular native invocation; later saves cannot borrow that run's evidence |
| Conflict | Token tied to logical head and captured incoming bytes/absence, with collision evidence |
| Retired/archive state | Reader-safe handoff, retained receipts and previous versions, without continued overlay authority |

SHA-256 of exact UTF-8 bytes remains the consumer CAS hash. Native size/modtime comparison is not a content hash. Mirror application also checks stored identity/stat evidence; unexplained same-hash replacement is conservatively a collision, not proof of ownership. Do not equate content equality with proof that an operation ID ran.

Validate all paths and Linux fd-relative traversal with `O_NOFOLLOW`; preserve bounded reads and regular-file checks. Index keys and blob names do not authorize arbitrary path traversal.

### Local commit

For every request:

1. Validate caller, generation, membership/revision, target and limits. Look up operation ID across **legacy and new** stores before current-version CAS. An exact duplicate returns its immutable original receipt, even after later edits; changed payload returns `operation_reused`.
2. Under the per-path publication barrier, resolve the current logical version. Create requires absence; replacement requires the expected logical hash and the consumer's complete-read proof. If there is no overlay, capture a validated stable mirror observation as the base.
3. Reserve pending, receipt and previous-version capacity before acceptance. Persist the new immutable bytes and previous logical bytes where required. Publish the generation/head and receipt transactionally, with admission rechecked at that boundary.
4. Return `saved_locally_pending_sync` only after durable publication. An uncertain transport reply is inspected by operation ID, never blindly replayed under a new ID.

An exact duplicate does not repeat append/task/property preparation. Define the new immutable request digest over the semantic target/kind/expected version/content/operation identity; changing only current transport authorization or negotiated protocol does not turn the same operation into a new mutation. Current authorization is still checked separately. Legacy request digests included the old serialized input: reconcile/index their stored semantic fields and exact content hash, test legacy replay explicitly, and never guess compatibility by recomputing the new digest against an old journal. Obsidian keeps its persisted transport-pending IDs, not a second content queue. A definitely published journal can be resolved after restart; corrupt or inconclusive publication is `uncertain`, not `not_saved`. Do not admit a successor on an uncertain path until recovery establishes its head.

## Normal single-path lifecycle

| State | Consumer authority | Next transition |
| --- | --- | --- |
| No active overlay | Validated native mirror | Successful local commit publishes generation G |
| Pending G | Immutable logical G | Idle application captures G; a later save may become the new head |
| Applying G | Current logical head, which may be G or a successor | Durable application proof becomes applied checkpoint G, or collision/uncertainty blocks application |
| Applied G awaiting run | Current logical head | A **following** eligible native run finishes; examine G and any successor |
| Conflict | Latest sound logical head, plus explicitly inspectable incoming version/absence | Explicit guarded resolution creates a new base/head or adopts incoming authority |
| Retired G | Native mirror | Receipts/recovery remain retained independently; future remote changes are visible normally |

### Applying without aliasing authoritative bytes

At a reserved native-idle boundary, reconcile old/new application journals and validate the mirror baseline. Choose the latest complete head under its short path barrier. Compare the current mirror against:

- the last proved owned application checkpoint, if one exists; otherwise
- the original external base.

This distinction matters: starting with A, applying local B, then saving C must recognize B as our own mirror write, not compare B to A and invent a remote conflict. Preserve A as historical collision/recovery evidence, not the permanent apply target.

Copy the selected blob into a **distinct, separately fsynced mirror-application inode**. Never hard-link the authoritative blob or recovery copy into the mirror, and never rename away its only immutable copy. For create, publish that independent apply-stage inode exclusively; for replace, atomically rename it after the final guarded comparison. Fsync the destination directory and application journal. Retain authoritative content independently.

A prepared/applying/applied journal records the **apply-stage** inode and intended generation. After crash, destination identity/hash and journal evidence establish applied/not-applied/uncertain under the native owner before another command starts. Ambiguous application retains both versions and stops unsafe mirror work; it does not erase the successful logical save or guess that a rename failed.

### Following run, successors and retirement

Before starting bisync, record which proved applied generation is eligible for that invocation. A save made during that run cannot count it as its following run.

After success, under native ownership and the path barrier:

1. Reconcile application proof and inspect the canonical path, exact local bytes/identity and native conflict artifacts. A failure, missing/changed canonical path, conflict or uncertainty prevents retirement.
2. If the active head is a successor of G, keep that successor authoritative. Advance/retain G's proved owned checkpoint as the basis for the next application; do not overwrite it with the original base or retire the successor.
3. If the active head is still G, the same eligible G survived the successful following run, and there is no unresolved state, atomically CAS the active pointer to **mirror authority**. The reader fence prevents a later save from being retired accidentally.
4. Retain the immutable receipt and bounded recovery bytes separately. Retiring authority also closes that overlay cycle: clear its **active** original-base/application checkpoint, retaining archival evidence separately. A later save after retirement captures the then-current mirror as a fresh base; it must not compare against an archived checkpoint from an earlier cycle. Garbage collection cannot invalidate an already-open reader or remove pending/uncertain content.

Required trace: A → local B → apply B → following successful run → retire B → independent remote C → native download → consumer reads C. Also test B → C before application, after application, during the following run and during retirement. An overlay must not shadow phone edits forever.

A completed run plus local matching bytes is a bounded native observation, **not verified cloud/device delivery**.

## Collisions and usable recovery

### Collision detection and native policy

Before application, a changed/deleted base or a remote create at a locally-created path is a collision. Do not overwrite it. Capture incoming bytes or absence under the native guard; preserve the acknowledged logical version and expose a conflict token. After application, preserve rclone's renamed conflict copies and detect canonical-path changes before retiring authority.

Do not promise more than stock bisync provides. Its unusual-sync rules retain a changed file against a deletion on the other side; after application, this can recreate a remotely deleted file without a renamed conflict copy. Preserve and test that native policy. A successful run and matching local path cannot prove that no remote deletion was overridden. No outbox-driven cloud delete detection, semantic merge or second reconciliation engine is proposed.

### Supported resolution protocol

Existing Retry/Rebuild controls do not settle one note. Add a bounded, caller-restricted protocol alongside note access:

- `noteInspectConflict`: metadata/token for the exact logical head and captured incoming version/absence. Existing `noteRead` gains an explicit guarded version selector for logical versus incoming content. Incoming absence is represented explicitly, not as an empty note. Reads retain ordinary output limits and complete-read evidence.
- `noteResolveConflict`: UUID operation ID/digest, conflict token, expected logical hash, expected incoming hash/absence, and an explicit choice: **keep local**, **accept incoming**, or **replacement content**. Compare the token/head and a fresh stable incoming observation before publication. Stale evidence returns conflict; no mutation or guessed overwrite occurs.
- Keep local/replacement publishes a new durable logical generation rebased on the observed incoming version/absence. Preserve incoming and previous acknowledged bytes. Normal guarded application handles subsequent races; choosing local against incoming absence explicitly authorizes recreating that path, rather than doing so automatically.
- Accept incoming content publishes/adopts that durable version while preserving the previous local bytes. Accept incoming absence durably archives the pending local version and hands authority back to the currently absent mirror; it does **not** issue a general file-delete operation. Future native changes can appear normally. If the incoming observation changed, require fresh inspection instead of deleting anything.
- Resolution has an immutable, deduplicated **resolution receipt**, distinct from a note-save receipt. Its outcome states adopted content or adopted absence honestly; do not fabricate a saved-note hash for deletion. Retain old content by recorded recovery identity within the documented recovery policy.

Expose inspection through Obsidian status/read and the explicit resolution intent through its edit handler and a narrowly scoped recovery RPC. The host sees Obsidian as the verified iCloud caller; client recovery routes have their own existing client boundary. Do not tell the operator to call an iCloud RPC that rejects that caller. No general editor UI, new permission switches or routine save confirmation.

Further complete local edits to a **sound** conflicted overlay are allowed with CAS: they produce a new head/token, retain collision evidence and remain locally visible, but application stays blocked until resolution. Inconclusive/corrupt local publication is different and stops new edits. Genuine conflicts may require the user to choose content; that is not an approval for every write.

This protocol is an engineering recommendation requiring implementation proof. If its interface or preservation semantics cannot be provided within this slice, stop rather than ship a permanently stranded queue.

## Reads, discovery and compatibility

### Continuous local view

Overlay reads never touch the worker-owned mirror. Otherwise use bounded stable fd/stat/name validation against native publication. Production omits `--inplace`; verify actual pinned native download/replacement/interruption behavior before allowing concurrent mirror reads. Stat equality alone is not proof against every possible in-place writer. Genuinely unstable files get safe per-note failure/incompleteness, not a service-wide sync-busy error.

Merge native listing and validated overlay keys, deduplicate, and resolve the current logical head on every read. Save followed by read/metadata/task parsing/link resolution for that path sees the new bytes, including a create not yet present in the mirror.

Search/task scans remain bounded: currently 500 notes, 16 MiB, three seconds, 500 rows; native enumeration caps 10k entries. The guarantee is **fresh logical bytes for every path actually scanned**, not a hit for every saved note in an arbitrarily large vault. No post-save stale cache may override the new head. Over-limit/time-limited no-hit results must explicitly be incomplete, never evidence of absence. Any overlay-first ordering must be bounded and not starve unedited paths. Existing cursors remain explicitly point-in-time; new scans use the current view. Sync progress/phase/last-success changes alone do not expire cursors; configuration/revocation does.

### Source states

Recommended policy: initialized, intact local vaults support reads and durable local saves while syncing, paused or Apple-disconnected. Pause means **cloud delivery paused**, not loss of standing local write access. Retain account binding; never silently resume or drain cloud work after disconnect. A retryable network failure is not local unavailability.

Initialization, retained/rebuilt IDs, missing/invalid baseline, corrupt content, uncertain ownership and destructive recovery remain safety boundaries. A sound acknowledged overlay may remain readable while mirror application is stopped. Define each admission condition explicitly rather than equating cloud freshness with filesystem health.

### Version negotiation and raw paths

Advertise note-access v2 with per-source **local availability** computed and enforced by iCloud. Obsidian consumes that capability instead of deriving local read/write eligibility from sync phase, account connection or last-success timestamps. Diagnostic freshness remains separate. Establish local readiness from intact local storage, baseline and actual generation ownership; a remote authorization/listing check must not sit on the ordinary local read/write path.

Require a matching negotiated capability at **eligibility, connect, configure, read, write, receipt and recovery admission**, including producer enforcement. Keep configured identities visible with an incompatibility explanation; they are not eligible choices or empty success. Merely returning `setup: incompatible` alongside usable sources is insufficient. Version both copied contracts together; test both mixed-upgrade orders.

Remove `localFolder` from the supported public inventory/tool output and update documentation and Obsidian parsing. The source audit found Obsidian as the only in-repo consuming plugin; it currently validates then discards that path. Record that audit at delivery. Do not claim unknown external raw-folder consumers migrated or that OS reads share overlay visibility. If a supported outside consumer cannot migrate, this is a compatibility blocker, not permission to weaken the contract. No operator-only raw endpoint is needed unless an actual consumer justifies one.

## Bounds, progress and retention

Initial engineering acceptance budgets, to validate before delivery; changes require recorded parent approval:

- Existing 1 MiB/note and 10k enumeration limits.
- Pending content: 64 MiB / 256 active paths globally; 16 MiB / 128 paths per vault. Count staged reservations, active versions and unreconciled generations without double-counting shared immutable content.
- Definite compact operation receipts: separate from hot pending capacity, retain the existing 30-day time-bearing UUID replay fence. Propose 32,768 rows / 64 MiB, with explicit pre-acceptance refusal on exhaustion. Do not inherit the old 512-directory limit as an unnoticed cap on a month of ordinary small edits.
- Previous-version bytes: a separate bounded 64 MiB recovery budget, with documented retention and pre-acceptance reservation. Legacy archives are preserved. Pending and uncertain versions/IDs are never silently evicted. Definite expired receipts may be pruned only consistently with the UUID expiry fence; uncertain records remain inspectable and can force honest capacity refusal.

Look up legacy and new operation identities together before CAS; an old ID cannot become a fresh write after migration. Index/archival work must not scan every note or take a native-run lock on the save path. Test physical ENOSPC separately from logical quotas.

After each native command and on idle wake-up, reserve a finite application quantum: initially at most one second and 16 paths, round-robin over mirrors/paths. Native work receives its turn after the quantum; new writes do not indefinitely extend it. Coalesce application to the latest head while retaining earlier receipts/recovery. Local publication waits only for short local critical sections, not the command queue.

Measure the minimum successful drain per quantum under the declared healthy workload. The target is 16 ordinary paths per one-second quantum; failure to achieve it requires revising the scheduling/budget **before delivery with parent approval**, not silently relaxing progress. For P already-pending ordinary paths, quantum drain q, healthy maximum command duration D and quantum Q, record the conservative application bound `ceil(P/q) * (D + Q)`, plus scheduler wake-up. A later native observation also depends on that mirror's measured cadence. New arrivals go behind existing work; coalescing a hot path must not move another path backwards.

Acceptance workload: two mirrors, native runs lasting at least 40 seconds each, up to 16 dirty ordinary paths per mirror and 100 saves over five minutes including repeated edits. Under measured D ≤ 40 seconds plus the fixture's recorded tolerance, q ≥ 16 and Q ≤ one second, those 32 existing paths should apply within two idle opportunities (about 82 seconds plus tolerance/wake-up), without delaying save acknowledgments. Scale tests to the full 20-mirror limit with deterministic scheduling and report the general bound; do not pretend a serial 20×40-second pass still gives each mirror one-minute freshness. Arrival rates beyond service capacity receive pre-acceptance backpressure, never acknowledged data loss.

## Single-user installation: stop, update, start

The owner explicitly permits downtime and breaking changes for this single-user installation. **Do not build rolling upgrades, compatibility bridges, feature-activation flags, downgrade tooling or a general rollout framework.** Preserve note bytes, existing vault selections, credentials, receipts and recovery data; downtime is acceptable, losing acknowledged edits is not.

Validate generation ownership, legacy journals, baselines and new content on startup. Preserve old recovery data and immutable receipts. Switch both packages to v2 together; a mismatched consumer fails clearly rather than using an unsafe fallback.

Use supported BB controls for this maintenance sequence:

1. Record both plugins' enabled state and the currently enabled iCloud source IDs. Disable Obsidian first so no new note calls arrive, and wait for in-flight local publications to settle durably.
2. Pause the previously enabled iCloud sources through supported controls and let any active native run finish. Disable iCloud and wait for its local/application work and worker to stop. Cloud Pause alone is not enough: both plugin runtimes must now be stopped.
3. Update **both while disabled**. Await successful completion of each update, including BB's stabilization window, before enabling either. The parent inspected BB 0.45.0: activation preserves `row.enabled`, and `loadOne()` returns for a disabled plugin before invoking its runtime factory. Thus no new-format note edit or runtime migration can happen inside the automatic-rollback window. Prove this sequence with an isolated BB fixture before production; do not patch BB or assume waiting a fixed time is sufficient.
4. Re-enable iCloud only if previously enabled. Validate startup/local readiness, then re-enable Obsidian only if previously enabled. This starts the new runtime after managed update completion, not during candidate stabilization. Restore only the previously enabled source IDs with Resume and observe a completed scheduled run.
5. If startup fails, **leave the affected plugins stopped and fix the new version**. Do not automatically re-enable an old binary against a changed store. Keep note/recovery files intact and report the outage. There is no promised automatic downgrade after admitting v2 writes.

This is an operator procedure, not a new product feature or user-facing approval step. Ordinary sync after installation must still support prompt local saves. Candidate preparation/imports must have no top-level storage side effects while the plugin is disabled. Preserve the current simple deployment arrangement rather than adding machinery for hypothetical other installations.

## Implementation slices and evidence gates

All gates below remain **unverified** for this design. Complete the single-path lifecycle before adding scheduling and UI complexity.

1. **Executable contract and native publication probe.** Reproduce the empty picker and source busy state synthetically. Establish the incompatible-catalog admission regression. Verify actual pinned native temporary-file publication and stable reads. Use a real rate-limited native transfer of generated data held active ≥40 seconds; allow test-only bandwidth control without changing production settings or triggering transfer limits. A delayed JavaScript promise is not native evidence.
2. **One-path durable lifecycle.** Implement publication, exact dedup, independent apply inode, owned checkpoint advancement, following-run eligibility, retirement and later remote-edit visibility. Exercise A→B→C around every boundary and explicit conflict resolution before adding multi-vault orchestration. Stop if the store cannot recover a clear old/new/uncertain result.
3. **Crash and ownership proofs.** Real child-process SIGKILL immediately before/after blob fsync, blob-parent fsync, journal/index commit, logical pointer/receipt commit, reply loss, apply-stage fsync, mirror publish, destination-directory fsync and retirement. Assert pointer/receipt consistency, immutable blob isolation, no duplicate append/create and no unsafe replay. Start a replacement while an inherited native child owns the flock; prove no overlapping overlay writer or premature command/migration. Include admission/removal/disposal races.
4. **Native races and progress.** Real stock bisync covers remote creates/edits/deletes before and after local application, rename-both-sides conflict, the native changed-versus-deleted policy, interrupted downloads, deletion threshold and retryable/critical recovery. Prove no direct mirror mutation during active commands. Run repeated real long cycles on two mirrors, with competing reads and writes, application/drain timing and refusal tests; test deterministic full-cap scheduling separately.
5. **Integration and compatibility.** Update iCloud services/ports, note store/overlay, native worker/provider, contracts/server; update Obsidian adapter/service/ports/contracts/server and copied contract drift tests. Exercise every supported note/recovery path, all nine existing assistant tools, complete-read/CAS proofs, partial results, bounded oversized scans, legacy IDs and both mixed-version update orders. Remove sync-phase gates and raw-path publication. Keep caller restrictions and configuration revocation.
6. **Latency, retention and failures.** At least 100 accepted 1–64 KiB note saves over the five-minute two-mirror workload, including ≥30 during actual native activity and samples during idle application and receipt maintenance. Measure client-observed coordinated-RPC p50/p95/max plus local commit/fsync time separately. Target p95 <1 second, max <2 seconds excluding deliberate disk failure; no 40-second-tail saves or routine sync-busy results. Replay a month-equivalent 3,000 small-note edits with no pending backlog; show compact receipts/previous bytes, not 512 retained directories, determine admission. Explicitly test quotas, ENOSPC, corrupt blobs, inaccessible paths, symlinks, cancellation and sentinels in failure logs/results.
7. **BB and UX evidence.** Real BB/provider tools on generated data establish caller and durability boundaries; rendered desktop/narrow/keyboard/focus review establishes settings behavior. Test first-run/pending/connected/empty/incompatible/error/recovery states, long sync with picker open, refresh/navigation/removal races and clear paused/disconnected freshness. Reuse BB connection UI. No normal-save approval dialog. A synthetic rendered RPC fixture is not proof of real note access, nor is a provider call proof of rendered UX.
8. **Controlled delivery.** Follow [ship-feedback](../../.agents/skills/bb-ship-feedback/SKILL.md) with the offline sequence above: package tests/typechecks/shared checks, review diff, commit/push, disable Obsidian, supported Pause **before update preparation**, finish active work, disable iCloud, update only those two **while disabled**, await update completion, and then start the new runtimes. Preserve credentials/selections and restore only prior enabled plugins/sources. Prove the disabled-update procedure in an isolated BB fixture; do not add rolling-upgrade or downgrade features. On failure, keep stopped and fix forward. No personal-note reads or cloud/device mutations merely to pass a test; stop if safe quiescence or another required gate is unavailable. Verify versions, a completed scheduled run and a bounded read-only call/log check; report local latency, pending age and delivery evidence separately.

## Execution evidence and stop

A disposable, generated Linux alias-remote probe using stock rclone v1.75.2 and the existing bisync policy transferred 24 MiB at a test-only 512 KiB/s limit. The real native process ran **48,080 ms**; 1,856 concurrent canonical-file samples included 1,855 old-version observations and **zero** stat-stable torn samples. A native `.partial` coexisted with the old canonical file; the completed canonical file had a different inode and exact expected bytes. The executable fixture is [`scripts/probe-icloud-native-publication.cjs`](../../scripts/probe-icloud-native-publication.cjs). The parent independently reran the hardened fixture: **48,051 ms**, 1,855 samples satisfying the before/after stat checks, zero stat-stable torn samples, a partial download and a distinct completed inode. The fixture now excludes ambient provider configuration, bounds child lifetimes and reports fixed failure stages; total samples and stat-stable samples are counted separately. A first parent invocation failed binary preflight before transfer because no pinned executable was selected; the explicit pinned-binary invocation passed. This supports the actual tested native download/replacement path; it does **not** establish safety against hypothetical `--inplace` writers, interrupted replacement, every crash boundary or all note paths. No personal data or cloud account was used.

**Stop condition: automatic updater rollback can strand acknowledged v2 edits.** Inspection of the actual BB 0.45.0 updater shows that an update disposes the old generation, snapshots `data.db`, plugin secrets and host state, activates the candidate, and keeps it loaded during a **30-second stabilization window**. If it enters error status during that window, BB automatically restores the old registration/database and loads the old binary. The plugin's private `sync/` directory (the proposed overlay location, alongside native mirrors/baselines) is **not** in that snapshot. An acknowledged overlay edit after candidate activation but before an automatic rollback could remain only in the v2 logical view while the old binary returns the stale native mirror; that binary cannot enforce a v2 marker. Pause stops cloud scheduling, **not** local overlay publications. Draining before update preparation cannot close this *post-activation* window. The parent independently checked `bb-app@0.45.0`'s packaged `createPluginStateSnapshotOnDisk`, `activateManagedUpdate`, `restorePluginStateSnapshot` and rollback recovery functions and confirmed these boundaries. These are consequences of the updater's source-level behavior, not a destructive update experiment or a proof that production data was lost.

The owner then clarified that this is a single-user installation, downtime is acceptable, and no features should be added merely to ease rollout. The parent approved the **stop, update both while disabled, then start** procedure above. Further source inspection confirmed that managed activation retains the disabled flag and `loadOne()` skips the runtime factory for disabled plugins. This removes note admission and runtime migration from the stabilization window without changing BB, adding an activation framework or promising downgrade compatibility. Verify the procedure in a disposable BB instance. Cloud Pause alone, an elapsed-time guess or a marker ignored by an old binary would still be insufficient. The implementation agent stopped before overlay implementation, migration, version bump, commit/push, plugin update or personal-vault tests. The parent has preserved only the probe and documentation/evidence changes; no runtime plugin was changed or deployed. All other release gates remain unverified. The initial stop is superseded by the owner's explicit downtime decision and the parent-approved offline procedure. Implementation may resume; the fixture proof and all ordinary data-safety, latency and UX gates still apply.

## Approval status

The user explicitly accepted GPT-only review coverage and requested continuation. The parent approves this revised architecture for one sequential implementation agent, beginning with the native publication probe and single-path lifecycle. The overlay internals are the parent's engineering decision under the service contract, not a claim that the user selected a particular storage mechanism.

The owner subsequently authorized a single-user offline update and rejected rollout features. The parent approves resuming the same implementation under the stop/update/start procedure, with fix-forward recovery rather than old-binary fallback.

This approval is **not** permission to waive a data-safety gate or assert cloud/device delivery. Do not add raw-folder compatibility for hypothetical consumers; the supported note consumer is Obsidian. Failure to stop both runtimes during updates, unsafe native publication, an unusable conflict protocol or missed latency/progress targets are stop-and-report conditions. Prove or revise the affected design before delivery; do not silently weaken it. Routine verified shipping follows repository policy, with no unapproved personal-data reads or cloud/device test writes. No further review agents or parallel implementation are authorized by this plan.
