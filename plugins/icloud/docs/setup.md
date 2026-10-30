# Set up iCloud folders in BB

## Before connecting

Ask the host operator to provision stock rclone v1.75.2, `/usr/bin/flock` from util-linux, mounted procfs exposing child-process metadata to BB's service user and persistent storage on Linux according to the [host requirements](../../../docs/references/bb-host-requirements.md). BB reports a missing prerequisite; it does not install one. The first release supports Linux hosts and selected Drive folders, not Photos or whole Drive.

On a trusted Apple device, open **Settings → Apple Account → iCloud** and enable **Access iCloud Data on the Web**. Use a disposable folder or Obsidian vault for the first test. Supported app libraries appear through rclone's Drive backend; their visibility must be checked on the actual account.

## Connect and choose a folder

1. In BB, install **iCloud** from PA for BB and open its configuration page.
2. Enter the Apple account email and **ordinary Apple password** in the protected form. App-specific passwords do not work. Never put passwords or codes in chat, screenshots or logs.
3. Approve Apple's sign-in prompt on a trusted device. Enter the six-digit verification code in BB. Devices receiving an automatically sent SMS code can use the same code field. Selecting among several SMS phone numbers is not supported yet; use a trusted-device code instead. Advanced Data Protection is not part of the initial live verification; approval problems need separate investigation, not automatic changes to Apple security settings.
4. Choose **Choose a folder**. Use **Open** to browse into a folder and **Select** to choose it. BB assigns its local storage automatically. Parent and child selections cannot overlap.
5. Choose **Enable sync** and review the confirmation. Initial preparation downloads into a new empty local folder. After a successful baseline, background sync runs about once a minute. A run taking longer than a minute does not overlap the next run.

While a folder is running, a progress bar shows checking, transfers and finishing checks. Measured stages show bytes or file counts; stages without a known total show activity rather than an invented percentage. A transfer reaching 100% does not finish the whole sync. Progress updates about once a second while the settings page is open and disappears when the run succeeds or pauses after failure. No filenames or provider logs appear in the progress display.

**Sync is not a backup.** From 0.1.10 onward, BB delegates directly to rclone bisync without separate whole-folder listings or recovery-copy downloads. Rclone still compares both sides, retains conflicting edits, checks excessive deletions and handles normal interrupted-sync recovery. Overwrites and deletions can propagate without a saved old version. No backup directories or automatic Undo feature replace the retired layer. Previously saved recovery copies remain untouched; the old retention/pruning policy no longer runs.

The **Last successful sync** time changes only after successful completion. “Syncing” or an active worker is not proof that a phone edit reached BB. Open the disposable vault on the phone, make a harmless change, and confirm its content through the consuming integration before trusting the connection with personal data. Editing personal data or testing destructive changes needs separate approval.

## Everyday controls

- **Pause** stops future scheduled runs or a pending retry, preserving local files, the baseline and the last failed outcome. A running operation must finish before controls can change it.
- **Resume** enables an intact paused mirror. For a failed mirror waiting after Reconnect, it runs the ordinary native bisync path; it never forces resync. Retained previous mirrors cannot resume.
- **Retry sync** is available for an initialized failed mirror whose automatic retry is paused, including conservatively upgraded legacy records. It uses the ordinary path and does not clear the old outcome before the attempt.
- **Reconnect** repeats Apple authorization and makes each enabled, recoverable folder wait for explicit **Resume**. Authorization succeeding does not restart any of those folders. Paused and retained folders stay stopped, and existing storage, configuration or critical blockers remain in place. Rclone's documented trust-token lifetime is about 30 days.
- **Disconnect** removes local password/session credentials and pauses sync. Local files and recovery copies remain. It does not revoke authorization at Apple. Remove/uninstall behaviour is governed by BB's host data policy; archive local data before asking BB to remove plugin data.

## Recovery

Legacy recovery archives, including incomplete or ambiguous staging, are preserved without being inspected or changed by sync. They are no longer a precondition for an ordinary attempt. An already saved capacity or critical blocker is not cleared automatically; review its cause separately rather than assuming it came from the retired backup layer.

A temporary failure or interruption remains visible and retains the last successful timestamp. If the folder is still enabled, BB retries on its ordinary schedule. Choose **Pause** to cancel future attempts while keeping the failure visible. Pending and active retries use calm status messages; stopped conditions needing action use error messages.

An interrupted initialized bisync may already have changed either side. Rclone's normal `--resilient --recover` path decides what it can continue; BB never claims rollback, bypasses deletion checks or adds `--resync`. A pinned native retryable-abort marker on exit 7 now leaves an initialized mirror eligible for the ordinary scheduled retry; a native resync-required marker, ambiguous output, or exit 7 alone remains blocked. This does not clear an already saved blocker. While that next run is active the UI says **Retrying**, and it advances the last-success time only after full completion.

1. If Apple authorization needs attention, use **Reconnect**, finish authorization, then choose **Resume** separately for each recoverable folder you want to sync. Reconnect alone does not revive explicitly paused, disconnected or retained mirrors. The plugin recognizes stock rclone's exact native trust-token-expiry error through a harmless private control-socket read; an HTTP 500 or an arbitrary provider message alone is not proof of expired authorization.
2. If an initialized failed mirror is paused and has no safety blocker, choose **Retry sync**. This is the supported path for eligible legacy failures too; it performs native bisync safety checks without taking whole-folder recovery copies.
3. If capacity or host/rclone configuration is blocking the folder, do not create a fresh mirror. Fix the reported condition first, asking the operator if needed, then choose **Retry sync**. Retry performs ordinary rclone checks. A failed retry restores its blocker; these states never enter the automatic retry loop.
4. For a critical sync-record failure, an unresolved legacy blocker or ambiguous initial preparation, choose **Create fresh mirror** only if you want a new local view downloaded from current iCloud. The confirmation explains that old unsent edits remain separately and are not merged or uploaded. The previous local folder stays in the inventory; consumers must explicitly select the new mirror.
5. Review old unsent edits before editing a new mirror. Restoring or merging wanted versions remains an operator-assisted action requiring scope review and consent.

### Operator inspection

All locations are allocated under the plugin's own persistent directory, derived from its scoped database. Do not put operator paths into user-facing configuration. Within the allocated sync area:

- `mirrors/<id>/`: local files; retained previous mirrors are not deleted automatically.
- `baselines/<id>/`: preparation/initialization markers and bisync listings/locks.
- `backups/snapshots/`: legacy JSON manifests mapping mirror identifier, capture time, side (`cloud`/`local`), relative filename and SHA-256 blob identifier. Complete schema-2 manifests also hold opaque version fingerprints and an ordered generation. Sync no longer reads, writes or prunes these archives or any `backups/staging-*` evidence.
- `backups/blobs/`: previously saved immutable file copies shared across identical snapshots, left untouched.
- `state/`: encrypted rclone configuration. `secrets/` holds its separately protected encryption key and key-reader helper. Protect both; a backup of ciphertext without its key cannot recover the connection.

For a previously saved recovery copy, find the chosen mirror/time/side in a manifest, then copy its referenced blob to a separate review directory using the manifest's relative filename. Validate the relative path remains inside that review directory. Never restore blindly into an active mirror, print file content or credentials in diagnostics, or run a mass restore merely to test installation. The first release provides fresh-mirror recovery in BB; reviewing/restoring individual historical versions is an operator-assisted task.

Schema-2 cloud filenames use the pinned rclone standard encoding, marked by `cloudPathEncoding: "rclone-standard"`; local filenames and legacy manifests use native filesystem names. For unusual cloud filenames, reconstruct an isolated encoded review directory and let stock rclone translate into a separate empty native review directory, for example `rclone copy ':local,encoding=0x2018002:/absolute/review-encoded' /absolute/review-native`. Do not decode paths by hand or restore into an active mirror. The numeric encoding is the pinned standard `Slash,Del,Ctl,Dot` mask, not an account setting.

An operating-system flock at `/usr/bin/flock` prevents worker overlap. Command children inherit the lock, so it stays held across a parent crash until the last old child exits. Mounted procfs lets a replacement plugin generation identify and defer to a live same-parent daemon without signalling it or replacing its lock/socket paths. Never bypass the lock; confirm no child is alive before operator inspection. Preserve baseline, staging and recovery files and inspect possible partial mutations.

After an abrupt native transfer termination, rclone may retain a non-empty bounded `<name>.<8-hex>.partial` file alongside the subsequently recovered full object. That partial can contain unique evidence. The plugin does not delete it automatically; inspect it separately before any operator cleanup.

## Diagnostics

### Rotating rclone activity logs

Every future native bisync attempt requests rclone's JSON DEBUG activity and saves a **projected diagnostic trace**, not a raw log dump. Read the latest 100 records without starting, retrying or changing a sync:

```sh
bb plugin rpc call icloud rcloneLogs --json
```

The optional input accepts `{"limit":500}` (1–500), supplied with `--input-file`. Records have host UTC timestamps, a generated per-command ID, elapsed milliseconds, start/finish/timeout boundaries, native component/line, recognized listing/comparison/retry activity, validated HTTP status numbers and fixed error categories such as timeout, DNS, connection reset or rate limiting. Native statistics include checks, transfers, errors, current activity counts and retry/fatal-error flags. A category means recognized text was observed, not an independently established root cause or proof that a write was not applied. Unknown messages remain `unknown`; raw messages are deliberately not recoverable from this trace. Component/line metadata helps locate the emitting code in the pinned rclone version.

Only bisync stderr is observed. The control daemon, account setup commands, control-socket requests/responses and password helper are **not captured**. No filenames, note bodies, account identifiers, URLs, headers, cookies, tokens or arbitrary provider text are copied into storage. HTTP body/header dumping is never enabled. This is more detailed than the failure-only BB log but is not a full provider audit trail.

Storage is allocated under the plugin's persistent `sync/rclone-logs/` directory, separate from mirrors, baselines, credentials and run-history SQLite. `rclone.jsonl` is current; `.1`, `.2` and `.3` are older, newest first. There are **at most four files of 1 MiB each (4 MiB total)**, with automatic size-based rotation across reloads. The directory is private (0700), files are private (0600), and only the native worker's owner writes them. Rotation replaces the oldest trace, not mirror data or run history. No particular number of days is guaranteed; heavy DEBUG activity rotates faster.

Each record is capped at 4 KiB and the asynchronous queue at 256 records (at most 1 MiB plus a 64 KiB write batch). A full queue drops trace records instead of blocking rclone. `droppedRecords` counts queue/schema drops in the current plugin generation, not all historical loss. `queuedRecords` reports pending writes; `incomplete` reports known omissions/corruption or pending capture. A bounded tail is not an atomic or exhaustive record of a run, and rotation/crashes can remove older evidence. Trace writes are best effort, not crash-durable. Read access never flushes, rotates, prunes or creates trace files.

Storage failure disables capture for that worker generation and emits one bounded `iCloud rclone_log_write unavailable` warning. An unavailable read separately emits one bounded `iCloud rclone_log_read unavailable` warning per plugin generation. `available: false` / `failure: unavailable` must not be interpreted as an empty successful log. Sync results, retry decisions and note access are unchanged by capture failures. Existing failures before this change cannot be reconstructed. Capture begins only when the changed code is actually applied; a build or Git commit does not enable it on a running installation.

### Failure summaries and retained run history

BB logs failures, not routine success or every status poll. Lines identify an operation/stage and safe category, for example `iCloud connect authentication`, `iCloud sync/checking sync_failed run=12 evidence=command_exit exit=5` or `iCloud sync/transferring interrupted run=13 evidence=command_timeout`. The run number is generated inside the plugin, not an account or folder identifier. Command evidence distinguishes an exit, timeout, output limit, signal, startup failure or deliberate shutdown; unknown exit codes are reported as unknown. No raw stderr is retained or parsed for provider messages.

Stock-rclone exit codes have bounded meanings: 2 is usage error, 3 directory missing, 4 file missing, 5 temporary error, 6 non-retry error, 7 fatal error, 8 transfer limit, 9 no transfer and 10 duration limit; 1 is otherwise uncategorized. Exit 7 alone cannot distinguish a resilient retryable abort from a resync-required lockout. On new bisync runs, a complete pinned v1.75.2 native JSON log record (including its rclone source metadata) supplies `native=retryable_abort` or `native=resync_required_abort`; missing, malformed, truncated, conflicting or oversized observations yield `native=unknown_fatal` and block retries. An exact native listing-failure marker can additionally supply `reason=listing_failure`. Example: `iCloud sync/checking sync_failed run=12 evidence=command_exit exit=7 native=retryable_abort reason=listing_failure`. These fixed terms also appear in bounded persisted run history. They distinguish rclone's decision, not a private file, Apple's underlying HTTP response, or whether a provider write was applied. Older failures cannot be reclassified from old history or listing files; their original underlying causes cannot be recovered retrospectively.

A separate scoped SQLite history keeps successful summaries for seven days and failures/interrupted summaries for 30 days. Healthy runs cannot evict errors. Expired entries are omitted when read and pruned on subsequent writes or restart. Independent emergency caps are 20,000 successful rows / 16 MiB of summary payload and 5,000 error rows / 8 MiB; SQLite/index overhead is additional. If a cap shortens coverage, `trimmed` reports capacity-removal counts and a bounded `history_retention capacity` warning is emitted once per plugin load, not on every success. The `capacity` object describes these persistent-store budgets. Each summary includes initial-versus-normal sync, timestamps, monotonic duration, outcome, stage durations/counters, reused-file counts and safe failure evidence. Folder/account names, paths, provider identifiers, credentials, content and arbitrary exceptions are excluded. New counters are observed native transfer statistics, not a provider audit trail. Historical backup stages/counters remain readable for earlier runs; keeping their schema does not imply that backups are still being taken.

Operators can read the history without starting or retrying a sync:

```sh
bb plugin rpc call icloud diagnostics --json
```

The default result is the latest **20 per page**, not the whole retained history. `retained` counts all still-visible successes/errors. Use the returned `nextBefore` as `before` to request an older page; a null cursor means that query has no older page. The optional input object accepts `limit` (1–100), `before` (a positive run sequence), and `outcome` (`all`, `errors`, or `succeeded`). For example, save `{"outcome":"errors","limit":100}` as a query JSON file and supply it with `--input-file <query-file>` to read errors without newer successes hiding them. Capacity counters do not include normal age expiry.

The first upgrade imports the available old KV summaries once and leaves that bounded legacy value intact for rollback/reference; summaries already evicted by the old 20-run limit cannot be reconstructed. Active SQLite records follow the retention policy above; host update snapshots and the frozen legacy value are separate from the current diagnostic view.

`active` contains only a pending-run marker, not persisted live progress. After an unclean restart, its summary is `interrupted` with unknown duration/stage; it is not proof that sync writes were rolled back or never applied. `persistent: false` means history could not be read or saved, or is in memory only. After a storage failure, reads use a partial temporary cache of up to 20 successes and 20 errors, kept separately; those counts do not establish full disk coverage. The plugin logs a fixed `history_read`/`history_write unavailable` warning, does not overwrite an invalid legacy value or malformed row encountered on read, and does not retry or fail a provider operation merely to repair diagnostics. Failed runs still require the normal recovery review.

An unrecognized error is `unknown`; raw provider messages, bodies, account addresses, filenames, tokens and exception stacks are excluded from both logs and history. Use protected settings and safe diagnostics, not raw provider logs in chat. A progress stage is display and diagnostic context, not proof that a failed command made no writes.
