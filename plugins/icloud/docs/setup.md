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

The **Last successful sync** time changes only after successful completion. “Syncing” or an active worker is not proof that a phone edit reached BB. Open the disposable vault on the phone, make a harmless change, and confirm its content through the consuming integration before trusting the connection with personal data. Editing personal data or testing destructive changes needs separate approval.

## Everyday controls

- **Pause** stops future scheduled runs, preserving local files and the baseline. A running operation must finish before controls can change it.
- **Resume** enables an intact paused mirror. It does not resume failed or retained previous mirrors.
- **Reconnect** repeats Apple authorization and pauses selected folders. Rclone's documented trust-token lifetime is about 30 days. Reconnecting does not automatically resume any folder.
- **Disconnect** removes local password/session credentials and pauses sync. Local files and recovery copies remain. It does not revoke authorization at Apple. Remove/uninstall behaviour is governed by BB's host data policy; archive local data before asking BB to remove plugin data.

## Recovery

A failed or interrupted sync pauses. Do not try to bypass a lock, force deletion checks, erase baselines or run an automatic resync. The phone or iCloud may already have received some changes.

1. Keep the previous local folder and recovery copies. If Apple access expired, reconnect first.
2. In **Recovery steps**, choose **Create fresh mirror** only if you want a new local view downloaded from current iCloud. The confirmation explains that old unsent edits remain separately and are not merged or uploaded. The previous local folder stays in the read-only folder inventory with phase `retained`. A new mirror receives a different identifier and local location; consumers must explicitly select it rather than silently switching.
3. Review old unsent edits before editing the new mirror. Ask the host operator to restore/merge wanted versions only after checking their scope and obtaining consent.
4. If capacity is the problem, have the operator inspect space and retention first. A fresh mirror does not bypass capacity checks or an interrupted recovery-copy staging tree.

### Operator inspection

All locations are allocated under the plugin's own persistent directory, derived from its scoped database. Do not put operator paths into user-facing configuration. Within the allocated sync area:

- `mirrors/<id>/`: local files; retained previous mirrors are not deleted automatically.
- `baselines/<id>/`: preparation/initialization markers and bisync listings/locks.
- `backups/snapshots/`: JSON manifests mapping mirror identifier, capture time, side (`cloud`/`local`), relative filename and SHA-256 blob identifier.
- `backups/blobs/`: immutable file copies shared across identical snapshots.
- `state/`: encrypted rclone configuration. `secrets/` holds its separately protected encryption key and key-reader helper. Protect both; a backup of ciphertext without its key cannot recover the connection.

For a recovery copy, find the chosen mirror/time/side in a manifest, then copy its referenced blob to a separate review directory using the manifest's relative filename. Validate the relative path remains inside that review directory. Never restore blindly into an active mirror, print file content or credentials in diagnostics, or run a mass restore merely to test installation. The first release provides fresh-mirror recovery in BB; reviewing/restoring individual historical versions is an operator-assisted task.

A stale worker lock or a failed staging tree requires operator inspection while BB's plugin and any child rclone process are stopped. Confirm no worker is alive before changing locks; preserve baseline/staging/recovery files and inspect possible partial mutations. The plugin will not clear these automatically, including when creating a fresh mirror.

## Diagnostics

BB logs bounded lines such as `iCloud connect authentication`, `iCloud sync/checking capacity`, `iCloud sync/backing_up_cloud sync_failed`, `iCloud sync/verifying recovery_required` or `iCloud restart interrupted`. An unrecognized error is `unknown`; raw provider messages, bodies, account addresses, filenames, tokens and exception stacks are excluded. A generic sync failure cannot establish that no provider write happened, which exact file failed, or whether Apple authorization expired. Inspect state and use protected settings, not raw provider logs in chat.
