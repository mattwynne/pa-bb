Drafted by Matt's robot

# Set up iCloud folders in BB

## Before connecting

Ask the host operator to provision stock rclone v1.75.2 and persistent storage according to the [host requirements](../../../docs/reference/bb-host-requirements.md). BB reports a missing executable; it does not install one. The first release supports Unix hosts and selected Drive folders, not Photos or whole Drive.

On a trusted Apple device, open **Settings → Apple Account → iCloud** and enable **Access iCloud Data on the Web**. Use a disposable folder or Obsidian vault for the first test. Supported app libraries appear through rclone's Drive backend; their visibility must be checked on the actual account.

## Connect and choose a folder

1. In BB, install **iCloud** from PA for BB and open its configuration page.
2. Enter the Apple account email and **ordinary Apple password** in the protected form. App-specific passwords do not work. Never put passwords or codes in chat, screenshots or logs.
3. Approve Apple's sign-in prompt on a trusted device. Enter the six-digit verification code in BB. Devices receiving an automatically sent SMS code can use the same code field. Selecting among several SMS phone numbers is not supported yet; use a trusted-device code instead. Advanced Data Protection is not part of the initial live verification; approval problems need separate investigation, not automatic changes to Apple security settings.
4. Choose **Choose a folder**. Use **Open** to browse into a folder and **Select** to choose it. BB assigns its local storage automatically. Parent and child selections cannot overlap.
5. Choose **Enable sync** and review the confirmation. Initial preparation downloads into a new empty local folder. After a successful baseline, background sync runs about once a minute. A run taking longer than a minute does not overlap the next run.

While a folder is running, a progress bar shows checking, saving recovery copies, transfers and finishing checks. Measured stages show bytes or file counts; stages without a known total show activity rather than an invented percentage. A transfer reaching 100% does not finish the whole sync. Progress updates about once a second while the settings page is open and disappears when the run succeeds or pauses after failure. No filenames or provider logs appear in the progress display.

Before applying sync changes, BB saves recovery versions on the host. After one full backup to establish an index, unchanged files normally reuse verified copies; cloud changes and local edits/deletions trigger fresh cloud backups for the affected paths. Local contents are hashed, not assumed unchanged from timestamps. Unknown cloud modification metadata and encoding-sensitive filenames use a conservative fresh-download fallback. Legacy manifests and expired indexes require another full backup. A newly seeded local mirror may also need a settling capture because its contents changed during initialization.

The **Last successful sync** time changes only after successful completion. “Syncing” or an active worker is not proof that a phone edit reached BB. Open the disposable vault on the phone, make a harmless change, and confirm its content through the consuming integration before trusting the connection with personal data. Editing personal data or testing destructive changes needs separate approval.

## Everyday controls

- **Pause** stops future scheduled runs, preserving local files and the baseline. A running operation must finish before controls can change it.
- **Resume** enables an intact paused mirror. It does not resume failed or retained previous mirrors.
- **Reconnect** repeats Apple authorization and pauses selected folders. Rclone's documented trust-token lifetime is about 30 days. Reconnecting does not automatically resume any folder.
- **Disconnect** removes local password/session credentials and pauses sync. Local files and recovery copies remain. It does not revoke authorization at Apple. Remove/uninstall behaviour is governed by BB's host data policy; archive local data before asking BB to remove plugin data.

## Recovery

If files change while recovery copies are being made, BB pauses before applying sync changes and keeps unfinished copies for review. Ask the host operator to review them before retrying; a changed-source warning is not evidence that the existing sync baseline is damaged.

A failed or interrupted sync pauses. Do not try to bypass a lock, force deletion checks, erase baselines or run an automatic resync. The phone or iCloud may already have received some changes.

1. Keep the previous local folder and recovery copies. If Apple access expired, reconnect first.
2. In **Recovery steps**, choose **Create fresh mirror** only if you want a new local view downloaded from current iCloud. The confirmation explains that old unsent edits remain separately and are not merged or uploaded. The previous local folder stays in the read-only folder inventory with phase `retained`. A new mirror receives a different identifier and local location; consumers must explicitly select it rather than silently switching.
3. Review old unsent edits before editing the new mirror. Ask the host operator to restore/merge wanted versions only after checking their scope and obtaining consent.
4. If capacity is the problem, have the operator inspect space and retention first. A fresh mirror does not bypass capacity checks or an interrupted recovery-copy staging tree.

### Operator inspection

All locations are allocated under the plugin's own persistent directory, derived from its scoped database. Do not put operator paths into user-facing configuration. Within the allocated sync area:

- `mirrors/<id>/`: local files; retained previous mirrors are not deleted automatically.
- `baselines/<id>/`: preparation/initialization markers and bisync listings/locks.
- `backups/snapshots/`: JSON manifests mapping mirror identifier, capture time, side (`cloud`/`local`), relative filename and SHA-256 blob identifier. Complete schema-2 manifests also hold opaque version fingerprints and an ordered generation. Incomplete retained captures are not reusable indexes.
- `backups/blobs/`: immutable file copies shared across identical snapshots.
- `state/`: encrypted rclone configuration. `secrets/` holds its separately protected encryption key and key-reader helper. Protect both; a backup of ciphertext without its key cannot recover the connection.

For a recovery copy, find the chosen mirror/time/side in a manifest, then copy its referenced blob to a separate review directory using the manifest's relative filename. Validate the relative path remains inside that review directory. Never restore blindly into an active mirror, print file content or credentials in diagnostics, or run a mass restore merely to test installation. The first release provides fresh-mirror recovery in BB; reviewing/restoring individual historical versions is an operator-assisted task.

Schema-2 cloud filenames use the pinned rclone standard encoding, marked by `cloudPathEncoding: "rclone-standard"`; local filenames and legacy manifests use native filesystem names. For unusual cloud filenames, reconstruct an isolated encoded review directory and let stock rclone translate into a separate empty native review directory, for example `rclone copy ':local,encoding=0x2018002:/absolute/review-encoded' /absolute/review-native`. Do not decode paths by hand or restore into an active mirror. The numeric encoding is the pinned standard `Slash,Del,Ctl,Dot` mask, not an account setting.

A stale worker lock or a failed staging tree requires operator inspection while BB's plugin and any child rclone process are stopped. Confirm no worker is alive before changing locks; preserve baseline/staging/recovery files and inspect possible partial mutations. The plugin will not clear these automatically, including when creating a fresh mirror.

## Diagnostics

BB logs failures, not routine success or every status poll. Lines identify an operation/stage and safe category, for example `iCloud connect authentication`, `iCloud sync/checking capacity`, `iCloud sync/backing_up_cloud sync_failed run=12 evidence=command_exit exit=4` or `iCloud sync/saving_recovery source_changed run=13`. The run number is generated inside the plugin, not an account or folder identifier. Command evidence distinguishes an exit, timeout, output limit, signal, startup failure or deliberate shutdown; unknown exit codes are reported as unknown. No raw stderr is retained or parsed for provider messages.

Stock-rclone exit codes have bounded meanings: 2 is usage error, 3 directory missing, 4 file missing, 5 temporary error, 6 non-retry error, 7 fatal error, 8 transfer limit, 9 no transfer and 10 duration limit; 1 is otherwise uncategorized. These codes do not identify a private file, establish Apple's underlying HTTP response, or prove a provider write was unapplied. The earlier generic backup error cannot be diagnosed retrospectively from them.

A separate scoped history keeps at most 20 completed runs. Entries older than seven days are omitted when read and pruned on subsequent writes or restart. It includes initial-versus-normal sync, timestamps, monotonic duration, outcome, stage durations/counters, reused-file counts and safe failure evidence. Folder/account names, paths, provider identifiers, credentials, content and arbitrary exceptions are excluded. Cloud-backup completion counts come from validated staging, including commands too short for a stats sample; other counters are observed transfer statistics, not a provider audit trail. Reused files are not counted as downloaded files.

Operators can read the history without starting or retrying a sync:

```sh
bb plugin rpc call icloud diagnostics --json
```

`active` contains only a pending-run marker, not persisted live progress. After an unclean restart, its summary is `interrupted` with unknown duration/stage; it is not proof that sync writes were rolled back or never applied. `persistent: false` means history could not be read or saved, or is in memory only; the plugin logs a fixed `history_read`/`history_write unavailable` warning, preserves malformed stored history, and does not retry or fail a provider operation merely to repair diagnostics. Failed runs still require the normal recovery review.

An unrecognized error is `unknown`; raw provider messages, bodies, account addresses, filenames, tokens and exception stacks are excluded from both logs and history. Use protected settings and safe diagnostics, not raw provider logs in chat.
