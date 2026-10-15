# Review record — continuous iCloud note access

Status: **revised draft; implementation not approved**. This record accompanies [plan 015](015-icloud-continuous-note-access.md). Design corrections below are not implemented or verified release claims.

## Artifact and actual coverage

The frozen first draft was reviewed over source commit `1baa405db6141a72c4096ce11885f9b495cc16f8`. Its SHA-256 was `f7af2bf3a10ac8878333b877fb9fe28b0f2fd6ec2d05dc895ae36c6b18dc1437`; the ledger entry was the other working-tree change in the snapshot. Every reviewer received that same snapshot, shared rubric and review-only constraints.

| Focus | Requested provider/model | Actual runtime provider/model |
| --- | --- | --- |
| Durability and native safety | `openai-codex/gpt-6.1-sol` | `openai-codex/gpt-6-sol` |
| Consumer contract and migration | `openrouter/anthropic/claude-sonnet-4.6` | `openai-codex/gpt-6-sol` |
| Latency and verification | `openrouter/google/gemini-3.1-pro-preview` | `openai-codex/gpt-6-sol` |

All three returned complete independent reports. Runtime provider/model fields established that explicit selections did not take effect. **This was three independent GPT contexts, not the requested multi-family ensemble.** Neither Claude nor Gemini executed. The routing cause is not established; do not describe this as an authentication, billing or model failure without evidence.

No review retries, authentication/configuration changes or further reviewers were launched. Full reports, frozen source, brief, hashes, runtime-routing record and parent synthesis remain in private session evidence. Reviewers performed no tests, provider calls or file edits. A later attempt to resume the original planner for document corrections failed because the session was unavailable; the parent made those corrections directly, without launching a replacement planner.

## Significant findings and parent verification

All reviewers withheld approval of the original draft. The parent verified the following against the plan and source rather than treating agreement as proof.

| Finding | Evidence / verification | Correction in revised plan |
| --- | --- | --- |
| The latest overlay never hands authority back | Original logical-version rule always preferred an overlay; GC addressed only superseded versions | Explicit reader-fenced retirement after the same applied generation survives a following native run; later remote-edit trace |
| A second edit can conflict with our own application | First-base-only comparison sees owned B as different from original A | Separate original base and advancing last-applied checkpoint; A→B→C cases |
| Application can alias immutable bytes | Existing `NoteStore.commit()` links create stages or renames replacement stages into the mirror; copying this pattern directly is wrong for a retained authoritative blob | Separate fsynced apply inode for create/replace; independent immutable bytes and crash proof |
| Conflicts cannot be settled using the promised interfaces | Default reads prefer the overlay; existing iCloud Retry/Rebuild are not per-note inspection/rebase | Guarded incoming/logical inspection and explicit deduplicated resolution, including incoming absence, with a supported Obsidian caller path |
| Version mismatch is only copy, not admission | Adapter returns incompatible setup with populated sources; service checks source phase rather than compatibility | Enforce v2 negotiation at every producer/consumer admission boundary and test both update orders |
| Search guarantees exceed bounded scans | Obsidian scan limits are 500 notes / 16 MiB / three seconds / 500 rows; native enumeration caps 10k entries | Fresh logical bytes for paths scanned, no stale post-save cache, explicit incompleteness rather than guaranteed hits |
| Raw-path consumers bypass the logical view | iCloud inventory/tool/README advertise locations; repository search found Obsidian as the only in-repo consumer and it drops the path after validation | Remove supported raw-path publication; migrate adapter/docs; do not claim external consumers or OS reads share the overlay |

The parent independently reproduced the compatibility issue with in-memory synthetic doubles: an `incompatible` catalog containing an initialized ready source produced one eligible vault, and `connect()` persisted membership. No real note, persistent store or live service was involved. This proves a current admission defect, **not** a working fix.

### Native deletion-policy limit

The pinned bisync reference's “Unusual sync checks” table states that a changed file survives a deletion on the other side and is copied back. Therefore a local edit applied before a run can recreate a remotely deleted file without a renamed conflict copy. Post-run matching local bytes cannot prove this did not happen.

The revision preserves native policy, requires that exact test, and removes the stronger promise to detect/prevent every such deletion reversal. It does not add another remote reconciler. Before-application mirror changes remain guarded collisions.

## Other corrections and proof still required

- Replace the removed service-wide lock with one concrete native-command/application arbiter; keep actual inherited ownership. Acquire/fence ownership before overlay publication and migration, and drain/fence disposal. Native idle is not required for ordinary overlay commits.
- Distinguish consumer revocation from undoing accepted edits. Old-revision operations cannot newly commit after removal; already acknowledged edits remain durable work for their original mirror/account, not a replacement ID.
- Define native application, retirement and conflict resolution crashes on both sides of fsync/transaction boundaries, including replacement generations with an inherited child.
- Define a save-latency workload, sample count, per-mirror cadence and conservative progress bound. Do not infer one-minute freshness across 20 serial 40-second jobs.
- Separate compact receipt retention from pending-path capacity and the old 512-operation directory cap. Retain legacy/new deduplication and UUID expiry fencing; test a month-equivalent editing workload.
- Define verified drain before downgrade across active, awaiting-run, conflicted and uncertain data. Old binaries cannot enforce a new marker; unsafe automatic rollback blocks rollout.
- Retain native publication/race/SIGKILL, diagnostics privacy, real BB/provider and rendered desktop/narrow/keyboard gates as distinct evidence. None has passed for the proposed implementation.

## Scope, uncertainty and decision

There was no material reviewer disagreement on the main lifecycle defects. Their shared model family limits the diversity of that evidence; consensus does not establish correctness.

The revised plan recommends local writes while paused/disconnected, bounded explicit conflict recovery, and API-only authority for supported note consumers. These are documented recommendations under the continuous-local-service requirement, not unrecorded user decisions. Actual outside raw consumers, native publication behavior, updater rollback behavior and measured budgets remain to be established.

The parent has **not dispatched implementation**. The requested multi-family review remains blocked by model routing. The revised design also needs parent inspection; documenting a state machine is not proof it is safe. No second review round or provider configuration changes are implied by this record.
