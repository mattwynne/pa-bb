# iCloud for BB

An independent iCloud Drive connection with protected Apple login/2FA, folder browsing, host-managed local mirrors and one-minute two-way background sync. It does not require a Mac relay or Obsidian desktop. Install it separately:

```sh
bb plugin install icloud@pa-for-bb
```

Follow the [setup and recovery guide](docs/setup.md). No folder syncs until **Enable sync** is confirmed. Use a disposable folder for the first live test. Photos and whole-Drive selection are not offered.

## Architecture

`core/ports.ts` defines `CloudProvider` and `StateRepository`. `core/service.ts` owns consent, connection/challenge state, selected folders, pause/resume, failure state, overlap prevention, restart handling and explicit fresh-mirror recovery. It knows no rclone flags, config fields, remote syntax or exit codes.

`adapters/rclone-cloud-provider.ts` delegates enumeration, comparison and two-way updates to stock rclone bisync. `rclone-process.ts` owns process lifecycle, encrypted configuration, separately protected keys and the private Unix socket. `server.ts` drives the core through authenticated HTTP forms, typed non-secret RPC and a durable BB schedule. Login credentials and 2FA codes are not agent tools or RPC inputs.

The read-only `diagnostics` RPC keeps successful sync summaries for seven days and failures/interrupted runs for 30 days, with independent capacity budgets so healthy traffic cannot evict errors. Responses default to a latest-20 page; older pages and errors-only queries remain available. Summaries include timings, safe counters and bounded failure evidence, never folder names, paths or provider messages. History storage failures are reported separately and never cause a provider retry. Legacy backup stages remain readable in old summaries. See [diagnostics](docs/setup.md#diagnostics).

Other integrations can call the read-only `inventory` RPC or use `icloud_list_local_folders`. It returns names, stable mirror identifiers, local note availability and last successful cloud sync—not raw host paths. Select by name/identifier, not a user-configured path. Inventory access is not consent to edit files. Retained previous mirrors remain listed separately and never sync again. [Obsidian](../obsidian/README.md) connects initialized mirrors separately for whole-vault read/write. From 0.2.0, the v2 note contract requires the host-verified Obsidian caller and an exact negotiated revision for configure/list/read/commit/receipts/conflict recovery. Both plugins must support v2; mixed versions refuse note access rather than use a raw-folder fallback. Inventory alone grants no edit access.

## Upgrading from 0.1.x

Update iCloud and Obsidian together to **0.2.0**. Record which plugins and sources were enabled. Disable Obsidian, use iCloud's supported Pause controls, let active sync finish, then disable iCloud. Keep **both plugins disabled until both managed updates have fully completed**, including stabilization. Enable iCloud first and check local readiness, then enable Obsidian if it was previously enabled. Resume only the sources that were enabled before maintenance. Keep previously disabled plugins disabled.

Existing vault selections, source identities, baselines, receipts and recovery copies are preserved. If an update or startup fails, keep both plugins stopped and preserve their files for inspection and a corrected update. Do not clear baselines or locks, force resync, or load an old binary after the new storage format has been admitted.

## Host requirements and security

- BB 0.45+, Node.js 22+, and stock rclone **v1.75.2**, provisioned by the operator according to [ADR 0001](../../docs/adrs/0001-provision-rclone-on-the-pa-host.md). Detect rclone on PATH or the ordinary Unix installation locations. The plugin never installs packages or invokes sudo.
- A Linux host with `/usr/bin/flock` from util-linux, mounted procfs exposing child-process metadata to BB's service user, persistent writable plugin storage and private Unix socket support. Other operating systems are unsupported. The socket path must fit the platform limit; an excessively long allocated storage path is refused.
- Storage is derived from BB's scoped plugin database location, outside installed code. Configuration, keys, caches, baselines and mirrors occupy separate subdirectories. Legacy recovery copies remain separate and untouched. Credential configuration uses rclone's native authenticated encryption, not password obscuring alone. Keys and the key-reader helper have protected permissions and are separate from the encrypted configuration.
- The key-reader helper sends its value to rclone through a private pipe. Passwords, codes and tokens never become process arguments, environment values or BB log fields. Inherited rclone/BB/provider environment values are excluded. Raw subprocess stdout/stderr and provider error text are not logged or shown to the agent.
- The socket is in a service-user-owned 0700 directory and is chmodded 0600. No network rclone listener or proxy to its general API is exposed. BB plugins and agents with unrestricted host execution remain full-trust code; these permissions are not an isolation boundary against the same operating-system user or root.
- Baselines and credentials survive reloads. An operating-system lock prevents overlapping workers; command children inherit it, so a parent crash cannot release exclusivity while an old transfer is still alive. Procfs child inspection lets a replacement generation defer to a live predecessor without signalling it or replacing its lock/socket paths. A recorded interrupted initialized sync remains visible and takes the ordinary native recovery path on the next enabled run.

## File behaviour and limits

Both conflicting edits are kept with numbered `icloud-conflict`/`bb-conflict` suffixes. Renames propagate as creation plus deletion. Normal initialized runs retain rclone's 50% maximum-deletion check and final listing checks and use stock rclone's default retries with `bisync --resilient --recover --max-lock 2m`. They never use force, automatic forced resync, bypass deletion checks or `--inplace`. Initial preparation uses resync only for a new empty local mirror with no existing baseline. When one side edits a file and the other deletes it, stock bisync may recreate the deleted file without a conflict copy. This layer does not detect cloud deletions independently; accepting an inspected incoming absence is not a general cloud-delete operation.

**Sync is not a backup or an Undo feature.** From 0.1.10 onward, BB does not take whole-folder recovery copies, download file bodies for backups or run separate before/after cloud listings. Each attempt delegates directly to native bisync. Overwrites and deletions can propagate to both sides without a historical version being saved. There is no new automatic native backup-directory policy replacing the retired layer. Use a separate backup if recovery of arbitrary changes is required.

Previously saved `backups/` files are not deleted, pruned, validated or used as a sync precondition. Their old 30-day/1 GiB policy no longer runs. Already saved capacity or critical blockers are not automatically cleared: review their provenance before using supported Retry or other recovery controls. The coordinated Obsidian boundary retains only the particular note being replaced, not changes from every device. Private note overlay bytes and previous versions live outside synced mirrors under the same inherited native-owner flock as bisync. A durable local save is visible to coordinated reads immediately, including while bisync runs; it does not prove delivery to iCloud. Pending bytes allow 64 MiB/256 paths globally and 16 MiB/128 paths per vault. Separate previous-version recovery allows 64 MiB; definite compact receipts allow 32,768 rows/64 MiB and retain the 30-day UUID replay fence. Uncertain references cannot be silently pruned. Capacity refuses new writes before publication. See the [note save and restoration contract](../obsidian/README.md#source-and-save-guarantees).

Two transfers/checkers, 4 MiB buffers, an 8 MiB/s bandwidth limit, a 256 MiB Go soft memory limit and a 256 MiB per-bisync transfer limit bound ordinary work. Native bisync has a twenty-minute command limit followed by bounded graceful shutdown; the removed wrapper's five-minute listing limit is no longer part of the sync path. Large folders or burst edits may still exceed native limits or encounter provider failures. This change removes extra work, not all possible slow syncs.

Pause/resume preserve an established baseline. Disconnect removes stored password/session credentials and pauses syncing without removing local folders or legacy recovery copies; it does not revoke Apple device trust. The encrypted account binding remains so retained local files cannot accidentally be sent to a different Apple account. To use another account, an operator must separately archive/reset the installation rather than mixing mirrors.

Temporary failures and interruptions keep the folder enabled and visible, preserve the last successful timestamp and retry through the next ordinary schedule. **Pause** cancels future attempts without erasing the failed outcome. Existing eligible initialized failed mirrors can use **Retry sync**, which runs native bisync checks without forced resync. Authorization failures require **Reconnect** and explicit per-folder **Resume**. Capacity and configuration failures never auto-retry; after correcting the condition, use **Retry sync**. Invalid selections are configuration failures, not storage failures.

Critical sync-record failures and ambiguous initial preparation never force a resync. Their confirmed **Create fresh mirror** path downloads current iCloud data into a different local folder and keeps the old folder and unsent edits separate; it does not merge or repair them. After an abrupt native transfer termination, rclone can preserve a non-empty bounded `<name>.<8-hex>.partial` file alongside the recovered full object. The plugin does not delete potentially unique evidence. See [recovery](docs/setup.md#recovery).

## Tests and verification

```sh
npm install
npm run typecheck
npm test
# Stock-rclone scenarios and process tests against generated local data:
RCLONE_TEST_BINARY=/path/to/rclone-v1.75.2 npm test
# After installing in an isolated running BB:
BB_REVIEW_BASE=http://127.0.0.1:PORT node test/rendered-review.mjs
```

Without `RCLONE_TEST_BINARY`, real-binary scenarios/process tests are explicitly skipped; a default pass is not provider proof. The real suite uses an alias to generated local data, never Apple. It tests native bidirectional edits, conflicts, deletion limits, interruption, locks and unchanged preservation of legacy recovery data. Adapter/host tests also prove that synchronization emits only bisync, missing baselines remain blocked, authorization expiry remains bounded and other blockers survive reload.

Native sync delivery evidence is recorded in [iteration 013](../../docs/plans/013-icloud-bisync-retry-classification.md); the original coordinated note boundary is recorded in [iteration 006](../../docs/plans/006-obsidian-vault-reading.md#release-evidence), and continuous local access, recovery and paired-update evidence in [iteration 015](../../docs/plans/015-icloud-continuous-note-access.md). Historical evidence and superseded whole-folder-backup behaviour remain in [008](../../docs/plans/008-incremental-icloud-recovery.md), [009](../../docs/plans/009-icloud-sync-diagnostics.md), [010](../../docs/plans/010-icloud-history-retention.md) and [011](../../docs/plans/011-rclone-first-icloud-recovery.md). Controlled rendering/generated filesystem tests do not prove real Apple expiry recovery or a phone-to-BB edit round trip.
