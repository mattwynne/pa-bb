# Connect an Obsidian vault

Connect a vault so BB can read and edit its notes. Changes sync through iCloud.
Desktop metadata and search can omit hidden folders.

## Requirements

- A single-user BB installation with BB 0.45.0 or newer, Node.js 22 or newer and
  the iCloud and Obsidian plugins installed separately.
- An iCloud plugin with coordinated note access v2 and an identity-bound local
  directory grant for the selected vault. Existing connections keep their IDs.
- A supported Linux iCloud host with stock rclone v1.76.0 (v1.75.2 remains supported), util-linux flock,
  mounted procfs and persistent writable plugin storage. The host operator handles
  provisioning; neither plugin installs system packages. See the
  [portable requirements](../../../docs/references/bb-host-requirements.md).
- A vault folder available in iCloud Drive and a Linux x86-64 BB host for automatic Desktop installation. Use a trusted vault with ordinary files and folders. Desktop
  follows filesystem links, so the selected vault must have no symbolic links,
  hard links to outside files or nested mounts that expose other directories.

## Search requirements

On Linux x86-64, connect a vault by name. BB downloads the official pinned
Obsidian Desktop 1.15.1 archive from GitHub, verifies its SHA-256 checksum and
installs Desktop and its bundled CLI together in private, persistent plugin
storage. The first installation needs outbound HTTPS, GNU tar, about 500 MB of
free space and permission to execute files there. BB reuses it across vaults,
plugin reloads and restarts. Each Desktop session uses a private profile and
checks restricted mode and vault identity before serving commands.

The host needs the Desktop runtime libraries (including GTK 3) and a working
Chromium namespace sandbox. Use the [Docker quick start](../../../docker/README.md)
when creating the BB container. If the existing container's policy blocks
startup, schedule a replacement with the documented flags and preserved volume.

If setup fails, the vault stays connected. Check the message in Obsidian settings,
correct the indicated network, storage or host prerequisite, then choose **Retry
Desktop setup**. A checksum failure discards the download before extraction.
For damaged installed files, stop the Obsidian plugin during a maintenance
window, move the affected version folder out of its plugin-owned `desktop`
directory, then enable the plugin again to fetch a verified copy.

### Optional overrides

Existing **Desktop executable**, **CLI executable**, **Desktop vault ID** and
**Desktop vault folder** settings and their environment equivalents
`PA_OBSIDIAN_DESKTOP`, `PA_OBSIDIAN_CLI`, `PA_OBSIDIAN_DESKTOP_VAULT_ID` and
`PA_OBSIDIAN_DESKTOP_ROOT` remain supported. A complete manual configuration
uses the supplied pair and skips the download. Use the exact connected vault
ID to restrict Desktop to one vault. If an iCloud folder contains several
vaults, set the ID and mirror-relative vault folder. Reload the Obsidian plugin
after changing overrides. For moves, enable automatic link updates in the vault.

## In BB: prepare iCloud first

1. Open **Plugins**, install or enable **iCloud**, then open its configuration.
   From Obsidian settings, **Open iCloud settings** opens the same host page.
2. Follow the [iCloud setup guide](../../icloud/docs/setup.md): connect Apple and
   finish Apple's verification in BB's protected form. Never send a password or
   verification code in chat.
3. In iCloud settings, choose the folder containing the vault. Enable two-way sync
   using iCloud's existing controls. That source setup is separate from connecting
   the initialized mirror to Obsidian.
4. Wait for the first successful sync. A selected folder or a running initial
   download is not yet an eligible vault.

## In BB: connect the vault

1. Return to **Plugins → Obsidian → Configuration**. The direct settings route is
   `/plugins/obsidian?configure=obsidian`; iCloud uses
   `/plugins/icloud?configure=icloud`.
2. Choose **Add vault**. Nothing is selected automatically.
3. Choose **Connect** beside the intended initialized vault. Duplicate names show
   their verified source IDs; choose carefully rather than relying on the name.
4. Repeat for another vault if needed. The connected view shows source status and
   last successful sync, not host paths or individual note contents.

Desktop operations become available when the connected vault is selected for
Desktop and the app starts. Installing the plugin alone connects no vaults.

## Ask the assistant

Examples for disposable test data:

- “Find the launch notes in my connected vaults. Cite the vault and note.”
- “Read that note, follow its internal link and list unfinished tasks.”
- “Add this decision, complete the task and add an alias without removing existing aliases.”
- “Create a meeting note in this existing folder, then link it from the launch note.”

The assistant should clarify genuinely ambiguous targets, not ask for routine
write permission. Each edit uses a complete-note version and conditional save.
Multi-note work has separate outcomes; creating one note does not prove its link
was saved elsewhere.

**Saved locally, pending iCloud sync** means exactly that. A later successful sync
is not proof of those bytes on a phone. Never ask for a repeated append merely
because delivery is slow or a sync failed.

## Check or remove a connection

Use **Check again** after changing iCloud setup. Returning to the tab refreshes
status; pending setup is checked at bounded intervals. A failed check keeps the
connections and offers another check, not an automatic reset.

**Remove** revokes that vault from future Obsidian content and receipt
access once iCloud confirms the configuration revision. A lost reply is unconfirmed;
choose **Check again** before treating removal as confirmed. Removal deletes no
notes and changes neither iCloud sync nor Apple login. An already acknowledged
local save is not undone. A rebuilt mirror has a different ID and must be
connected explicitly, even if its name is unchanged.

## Troubleshooting

| State | Next action |
| --- | --- |
| iCloud missing or disabled | Install/enable iCloud in Plugins. |
| iCloud starting or in error | Open its configuration and inspect startup/prerequisite guidance. |
| Incompatible iCloud | Update iCloud and Obsidian together. |
| Host prerequisites missing | Ask the host operator to check supported rclone, flock, procfs and storage. |
| Apple verification pending | Finish verification in iCloud's protected form, never chat. |
| No selected folder | Choose the vault folder in iCloud settings. |
| Sync not enabled / first sync running | Enable sync, then wait for its first successful run. |
| First sync failed | Inspect iCloud's failure and supported recovery steps; do not force resync just to connect Obsidian. |
| Running sync | Sound local notes remain available; cloud delivery is still in progress. A local safety blocker is shown separately. |
| Cloud paused or Apple disconnected | Sound local notes remain readable and writable. Cloud delivery is paused or stopped; report the last successful host sync time, not a stale/fresh judgment. Resume or reconnect when ready. |
| Local safety unavailable, retained or missing source | Check the specific mirror in iCloud settings. If it was replaced, connect the new mirror by its ID. A cloud retry failure alone does not revoke sound local access. |
| Could not check iCloud | Keep the connections and choose Check again. This is not evidence that iCloud is missing. |
| Concurrent note change | Reread the complete note and prepare the intended change again. |
| Lost reply / uncertain save or resolution | Inspect the exact persisted operation ID with `obsidian_status`, scoped to vault and path, even after restart. Do not repeat the change. |
| Note conflict | Inspect an exact vault and path with `obsidian_status`. Use `obsidian_read_note` with the token to read the incoming version. Choose keep local, accept incoming or replacement through `obsidian_edit_note` using the token and expected versions. Inspect again if the token is stale. For an ambiguous set of native copies, inspect the files in the vault directory. |
| Recovery capacity or expired operation | Ask the operator to inspect private note recovery and current bytes. Never delete journals or replay an expired request to force an append. |
| Malformed/unsupported properties or large note | Read the reported limits/warnings. The plugin refuses unsupported edits rather than normalizing or truncating a note. |

The [README](../README.md#resource-and-recovery-limits) records concrete format,
scan, output and retention limits and operator-assisted restoration. No browser,
editor, graph, history dashboard, approval queue or delete tool is supplied. The direct move tools and their receipts are described in the [README](../README.md#tools).
