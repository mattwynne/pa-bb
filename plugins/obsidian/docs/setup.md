# Connect an Obsidian vault

Connect a vault so BB can read and edit all its notes. Changes are sent back
through iCloud. Connecting includes nested and hidden Markdown folders; there
are no folder permissions, read-only settings or per-edit confirmations.

## Requirements

- A single-user BB installation with BB 0.45.0 or newer, Node.js 22 or newer and
  the iCloud and Obsidian plugins installed separately.
- An iCloud plugin advertising coordinated note access v2.
  Older versions need updating; Obsidian never substitutes raw filesystem writes.
- A supported Linux iCloud host with stock rclone v1.75.2, util-linux flock,
  mounted procfs and persistent writable plugin storage. The host operator handles
  provisioning; neither plugin installs system packages. See the
  [portable requirements](../../../docs/references/bb-host-requirements.md).
- A vault folder available in iCloud Drive. No Obsidian desktop app, plugin inside
  Obsidian, Mac relay or PA core is required on the BB host.

## Search requirements

Ripgrep search needs iCloud and Obsidian **0.3.1** and stock ripgrep available to
BB's service user. The [host manifest](../../../provisioning/README.md) pins the
Linux-validated 14.1.0 release. The host operator provisions it; the plugins do
not download or install executables.

If settings says **Vault search is unavailable**, keep your vault connections,
ask the operator to check these requirements, then choose **Check again**.
Ordinary reads, saves and sync do not depend on search availability.

Ask for YAML properties explicitly, for example: “Count notes whose `status`
property equals `active`.” Body text is not a property, and a note count is not
a deduplicated project count. The assistant must follow continuations until a
reliable total is available; partial or running matches are not a final count.
See [search and counts](../README.md#search-and-counts) for query scopes and limits.

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

Connecting immediately makes the whole vault readable and editable by the
assistant. There is no second permission dialog. Installing the plugin alone
connects no vaults.

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
| Incompatible iCloud | Update both plugins to matching v2; do not bypass coordinated note access. |
| Host prerequisites missing | Ask the host operator to check supported rclone, flock, procfs and storage. |
| Apple verification pending | Finish verification in iCloud's protected form, never chat. |
| No selected folder | Choose the vault folder in iCloud settings. |
| Sync not enabled / first sync running | Enable sync, then wait for its first successful run. |
| First sync failed | Inspect iCloud's failure and supported recovery steps; do not force resync just to connect Obsidian. |
| Running sync | Sound local notes remain available; cloud delivery is still in progress. A local safety blocker is shown separately. |
| Cloud paused or Apple disconnected | Sound local notes remain readable and writable. Cloud delivery is paused or stopped; report the last successful host sync time, not a stale/fresh judgment. Resume or reconnect when ready. |
| Local safety unavailable, retained or missing source | Check the specific mirror in iCloud settings. Connect a replacement by its new ID; no raw-folder fallback is used. A cloud retry failure alone does not revoke sound local access. |
| Could not check iCloud | Keep the connections and choose Check again. This is not evidence that iCloud is missing. |
| Concurrent note change | Reread the complete note and prepare the intended change again. The stale patch saved nothing. |
| Lost reply / uncertain save or resolution | Inspect the exact persisted operation ID with `obsidian_status`, scoped to vault and path, even after restart. Do not repeat the change. |
| Note conflict | Inspect an exact vault/path with `obsidian_status`; read logical and token-guarded incoming content or explicit absence with `obsidian_read_note`. Choose keep local, accept incoming or replacement through `obsidian_edit_note` using the token and expected versions. A stale token needs new inspection. The client recovery RPC offers the same narrow choice, not a general editor or routine approval. |
| Recovery capacity or expired operation | Ask the operator to inspect private note recovery and current bytes. Never delete journals or replay an expired request to force an append. |
| Malformed/unsupported properties or large note | Read the reported limits/warnings. The plugin refuses unsupported edits rather than normalizing or truncating a note. |

The [README](../README.md#resource-and-recovery-limits) records concrete format,
scan, output and retention limits and operator-assisted restoration. No browser,
editor, graph, history dashboard, approval queue or rename/delete tool is supplied.
