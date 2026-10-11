Drafted by Matt's robot

# iCloud for BB

An independent iCloud Drive connection with protected Apple login/2FA, folder browsing, host-managed local mirrors and one-minute two-way background sync. It does not require a Mac relay or Obsidian desktop. Install it separately:

```sh
bb plugin install icloud@pa-for-bb
```

Follow the [setup and recovery guide](docs/setup.md). No folder syncs until **Enable sync** is confirmed. Use a disposable folder for the first live test. Photos and whole-Drive selection are not offered in this first iteration.

## Architecture

`core/ports.ts` defines the need-shaped `CloudProvider` and `StateRepository` ports. `core/service.ts` owns consent, connection/challenge state, selected folders, pause/resume, failure state, overlap prevention, restart handling and explicit fresh-mirror recovery. It knows no rclone flags, config fields, remote syntax or exit codes.

`adapters/rclone-cloud-provider.ts` implements `CloudProvider` with stock rclone; `rclone-process.ts` owns process lifecycle, encrypted configuration, separately protected keys and the private Unix socket. `recovery-copies.ts` retains independent, content-addressed local recovery copies. `server.ts` drives the core through authenticated HTTP forms, typed non-secret RPC and a durable BB schedule. Login credentials and 2FA codes are not agent tools or RPC inputs.

Other integrations can call the read-only `inventory` RPC or use `icloud_list_local_folders`. It returns names, stable mirror identifiers, local locations, phase and last successful sync. Select by name/identifier, not a user-configured path. Inventory access is not consent to edit files. Retained previous mirrors remain listed separately and never sync again.

## Host requirements and security

- BB 0.45+, Node.js 22+, and stock rclone **v1.75.2**, provisioned by the operator according to [ADR 0001](../../docs/adrs/0001-provision-rclone-on-the-pa-host.md). Detect rclone on PATH or the ordinary Unix installation locations. The plugin never installs packages or invokes sudo.
- A Unix host with persistent writable plugin storage and private Unix socket support. Windows is unsupported in this iteration. The socket path must fit the platform limit; an excessively long allocated storage path is refused.
- Storage is derived from BB's scoped plugin database location, outside installed code. Configuration, keys, caches, baselines, mirrors and recovery copies occupy separate subdirectories. Credential configuration uses rclone's native authenticated encryption, not password obscuring alone. Keys and the key-reader helper have protected permissions and are separate from the encrypted configuration.
- The key-reader helper sends its value to rclone through a private pipe. Passwords, codes and tokens never become process arguments, environment values or BB log fields. Inherited rclone/BB/provider environment values are excluded. Raw subprocess stdout/stderr and provider error text are not logged or shown to the agent.
- The socket is in a service-user-owned 0700 directory and is chmodded 0600. No network rclone listener or proxy to its general API is exposed. BB plugins and agents with unrestricted host execution remain full-trust code; these permissions are not an isolation boundary against the same operating-system user or root.
- Worker locks, baselines and credentials survive reloads. A stale worker lock is never cleared automatically. Clean disposal stops children before releasing the worker lock. A recorded interrupted sync fails closed on restart.

## File behaviour and limits

Both conflicting edits are kept with numbered `icloud-conflict`/`bb-conflict` suffixes. Renames propagate as creation plus deletion. Normal runs retain rclone's 50% maximum-deletion check and final listing checks. They never use force, automatic resync, lock expiry, resilient retry or automatic recovery flags. Initial preparation uses resync only for a new empty local mirror with no existing baseline.

Before any sync changes, copy both sides into an independent local recovery store. SHA-256-addressed file copies and snapshot manifests deduplicate unchanged content. Keep versions for 30 days after their last snapshot use within a **1 GiB** total recovery budget; prune only expired manifests and unreferenced blobs. Budget staging space as well as retained data. Pause before sync if safe capacity is unavailable. These sequential snapshots are not an atomic snapshot of concurrent phone/BB edits and do not replace an independent host backup.

Two transfers/checkers, 4 MiB buffers, an 8 MiB/s bandwidth limit, a 256 MiB Go soft memory limit, a ten-minute command limit and a 256 MiB per-bisync transfer limit bound ordinary work. Very large folders, burst edits, huge listings or unexpectedly growing transfers may be refused or pause. The 1 GiB budget is shared by all selected folders; it is not a promise to retain unlimited changes for 30 days.

Pause/resume preserve an established baseline. Disconnect removes stored password/session credentials and pauses syncing without removing local folders or recovery copies; it does not revoke Apple device trust. The encrypted account binding remains so retained local files cannot accidentally be sent to a different Apple account. To use another account, a host operator must separately archive/reset this installation rather than mixing its mirrors.

After a failed run, **Create fresh mirror** downloads current iCloud data into a different local folder and explicitly enables its sync. It keeps the old local folder and any unsent edits; it does not merge them, resync the old folder or clear locks. Merging old edits or restoring recovery copies requires separate review and consent. See [recovery](docs/setup.md#recovery).

## Tests and verification

```sh
npm install
npm run typecheck
npm test
# Run real stock-rclone Gherkin and process tests against generated local data:
RCLONE_TEST_BINARY=/path/to/rclone-v1.75.2 npm test
# After installing in an isolated running BB:
BB_REVIEW_BASE=http://127.0.0.1:PORT node test/rendered-review.mjs
```

Cucumber-js runs both domain scenarios against a fake port and optional real-binary file-safety scenarios. Without `RCLONE_TEST_BINARY`, five real-binary Gherkin scenarios and three process tests are explicitly skipped; a default test pass is not provider proof. The real-binary suite configures an alias to generated local data and never contacts Apple. Adapter/fake-BB tests cover challenge mapping, credentials, bounded failure diagnostics, account binding, capacity, deduplication, expiry, protected controls and disposal.

Initial evidence: 19 Cucumber scenarios (172 steps) and 19 unit/adapter/host tests passed with stock v1.75.2. An isolated running BB rendered ten controlled states at 1280px and 390px, including folder browsing, keyboard focus, enable consent and recovery consent, and was compared with Fastmail. Those controlled rendered states do **not** prove live Apple authentication or app-library accessibility. Apple login/2FA, disposable-vault sync, provider-session expiry and running production feedback remain live verification tasks.
