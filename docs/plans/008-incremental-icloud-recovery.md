Drafted by Matt's robot

# 008 — Incremental iCloud recovery copies

Status: verified for iCloud 0.1.4; approved recovery and production deployment pending.

## Contract

Keep the cloud-provider port operations and normal two-way sync policy unchanged; add the need-shaped `source_changed` failure for unstable backup reads. Recovery storage remains immutable, SHA-256-deduplicated, retained for 30 days within the shared 1 GiB budget. Do not replace it with a mutable download cache or weaken conflict/deletion protection.

Before sync, list cloud file metadata and hash local files. A complete versioned recovery manifest indexes each path's cloud metadata fingerprint or local content/metadata fingerprint and verified recovery blob. Reuse a cloud blob only when its metadata is unchanged and the corresponding local file has neither changed nor disappeared since the previous capture. Local edits, additions and deletions force a fresh backup of any corresponding cloud file, even if cloud size/time/identity are unchanged: stock rclone exposes no iCloud content hash or ETag revision through its file listing. Metadata alone is not proof of equal content.

Download only the selected cloud files into private staging; reference already verified local blobs instead of copying every local file. Reserve capacity for the needed data, immutable copies, selection list and complete manifest before transfer. Keep historical versions on deletion or rename. Validate cloud metadata and local fingerprints again before publishing the manifest and permitting sync. If they changed, fail closed and preserve staging; no uncertain sync write is retried automatically. Missing/corrupt reusable blobs, malformed metadata, unsafe paths and interrupted staging likewise stop sync.

Legacy manifests and expired indexes require one full cloud backup to establish the index. Incomplete operator-retained manifests are retention evidence, never reusable complete indexes. Unknown cloud modification metadata is uncacheable and must be downloaded each time. Filename newline handling must not turn a private selection list into extra paths. Stock rclone's listing uses standard-encoded names, not native filesystem names: cloud staging uses a destination-only standard encoding, while bounded native streams copy new local blobs. Encoding-sensitive cloud names are conservatively downloaded each run rather than risking a mismatched cloud/local cache key. Manifests explicitly mark cloud path encoding; do not hand-decode restore paths.

The first upgraded run may remain slow. Later unchanged runs with comparable metadata and ordinary filenames must download zero file bodies. Unknown metadata and encoding-sensitive filenames retain the safe fresh-download fallback. Progress totals describe only the current stage's actual work, never skipped files or a fictitious whole-operation percentage. No provider identifiers, paths, file content or exceptions enter progress or diagnostics.

## Gates

Gherkin and generated-file tests cover warm no-change captures, targeted changes, local edit/deletion forcing cloud backup despite unchanged metadata, rename/deletion retention, migration, expiry, corruption, unstable reads, unusual filenames, capacity and interrupted staging. Exercise the actual pinned rclone with disposable files and retain all existing conflict/deletion/baseline safety gates. Run build/typecheck, affected tests and rendered BB review at desktop/phone widths.

Pause future scheduled runs through supported controls before update preparation. Update iCloud only, restore the previously enabled folder normally and observe bootstrap plus a later no-change run. Do not introduce edits in a real account merely to demonstrate performance. Record measured stage durations/download totals without private account content; report any unverified real-cloud change case honestly.

## Evidence and recovery scope

- 45 Cucumber scenarios / 403 steps and 48 unit/adapter/host tests passed without skips, including real stock-rclone no-change, targeted-change, conflict, deletion, and unusual-filename cases. Build, typecheck and shared UI drift checks passed.
- Running isolated BB passed 30 controlled states at 1280px/390px (60 cases), including the new changed-source warning without an inappropriate fresh-mirror action, progress lifecycle, setup/browser/approval states, focus, layout and reduced motion. Screenshots were inspected.
- Native local copies are bounded to planned sizes; multi-chunk, empty-file and growing-source tests passed. Reused blobs are verified; missing/corrupt/symlink blobs fail closed. Ordered generations choose the latest complete index independently of wall-clock ties.
- Repeated all release gates in the replacement session: 45 scenarios / 403 steps, 48 tests without skips, typecheck/build/shared UI checks, and 60 rendered-BB cases passed. A read-only preview against a private baseline copy completed in 42 seconds with no errors or proposed changes; the original baseline and local metadata stayed unchanged. Earlier 120/180-second previews timed out, but the timeout was not reproduced and its cause remains unknown.

The old installed release failed a cloud-backup read before two-way sync. Read-only inspection found unchanged successful baseline metadata, intact listings without lock/error/new-list files, and one incomplete recovery copy. The missing file's metadata and a protected download succeeded subsequently; the original underlying error remains unknown. The supported-pause watcher did not obtain an idle window and timed out without performing an update. The later failed state has already disabled future runs. Explicit consent authorizes preserving the incomplete versions, retaining the baseline/local folder, and normal resumption after this release passes all gates; it does not authorize a baseline reset or forced resync.

