# 031 — Make Obsidian Desktop the note backend

BB should ask Obsidian Desktop to work with notes, then delete the BB code that does the same work. Desktop starts when the Obsidian plugin is enabled and its vault is available. It stays running until BB unloads the plugin. iCloud continues to sync the same local vault. The Obsidian plugin supplies generic vault operations. The GTD plugin owns project and Area semantics, the Projects sidebar inventory, and conversation associations. [Iteration 030](030-obsidian-desktop-links.md)

## 1. Start Desktop with the plugin

- Replace the per-request launch and quit with one owned Desktop process, a private profile and a private CLI socket. Start it once the configured vault is available. If setup is missing or startup fails, show the reason when a command needs Desktop. Preserve the connected vault and its iCloud state.
- Use the existing direct vault grant and the official Linux binaries. Preserve restricted mode. The selected vault is operator-controlled and uses ordinary files and folders. Check the fresh-machine Docker setup and update provisioning only for demonstrated missing dependencies. [Docker setup](../../docker/README.md#optional-obsidian-desktop-cli)
- Exercise enable, disable, reload, BB restart and a Desktop crash. Check for one process tree, no leftover socket or child, and a usable first request. A failed or interrupted write has an unknown outcome until inspected. Starting Desktop again must never replay that write.

On a small disposable vault, Desktop took 1.16 seconds to start and used about 342 MiB while running. Warm read, search, property, task and backlink commands took about 1–2 ms each. Recheck with a representative vault and measure BB request time as well as the CLI call.

## 2. Move ordinary note operations to Desktop and delete the old BB code

- Replace BB’s implementations of backlinks, ordinary same-folder rename, plain note reads, text search, task listing and status changes, and supported single-property changes with the corresponding native commands. Use native results and error behavior where compatible. Open each vault and note by its exact authorized identity. Keep tool names where the request and result still mean the same thing. [Official CLI](https://obsidian.md/help/cli)
- Switch each tool once its main use cases work, then remove the old branch and its tests. Remove `desktop_rename` as a separate choice when ordinary rename uses Desktop directly. While Desktop is unavailable, report that state for migrated commands. Do not keep a second implementation behind a fallback.
- Preserve the generic vault contracts below. Use Desktop where it can meet the contract. Retain only code needed for guarantees the native operation cannot supply. Delete helpers with no remaining caller.
  - Exact text replacement must apply to the inspected revision and refuse a missing or non-unique match. Multi-property saves must apply the requested changes together against one revision. Both need a checked write so a concurrent editor’s changes survive.
  - Conflict recovery must inspect the specific local and incoming versions and apply the chosen resolution only while those versions still match. iCloud conflict state and the resolution receipt belong to BB’s sync integration.
  - Run cross-folder and folder moves directly through Desktop with explicit source and destination paths. At execution, validate access and refuse an occupied destination. Let Obsidian update links using its native behavior. Remove BB’s separate move preview and link planner. Record and check the actual file outcome so an interrupted request can be inspected before any retry.
  - Keep GTD status changes and recovery in GTD. GTD chooses the status destination, companion folder, property changes and conversation updates, then calls the generic move directly. Record the outcome of each step so GTD can finish an interrupted change. Replace project-specific move, defer, reactivation and title RPCs with generic operations and remove the old RPCs when their callers switch.

## 3. Move Projects inventory to Desktop

The disposable-vault experiment established that one fixed query using Desktop’s public Vault and MetadataCache APIs can supply the note data for 135 projects and 13 Areas in 2.7 ms. BB reproduced all 76 baseline Area assignments from those rows. The existing live sidebar took 184 ms at the median on warm reopen while Desktop was stopped. That is a rendered baseline. The Desktop-backed sidebar still needs an end-to-end parity and timing check. [Iteration 030 measurements](030-obsidian-desktop-links.md)

- Use the tested bounded query through the documented CLI with the existing vault authorization. Keep the expression BB-owned and fixed and use public APIs. Return generic note and folder paths, requested properties and coverage. GTD selects roots and properties, recognizes project notes, interprets status and Area declarations, and joins conversation records. Remove Obsidian’s project and Area lookup RPCs and matching rules when GTD switches.
- Require a landing note for every project. Empty and attachment-only folders without a landing note are omitted from the GTD inventory and Projects sidebar. Remove the folder-only project path and update the GTD skill. Preserve the folders, their contents, and stored conversation links.
- Check parity for note-backed projects and Areas, including IDs, assignments and conversation links. A landing note without frontmatter remains eligible for its path-based entry. When Desktop’s metadata cannot distinguish absent frontmatter from malformed YAML, check the landing note’s source. Flag malformed frontmatter as a data error, identify the affected note for repair, and mark the inventory incomplete. Avoid deriving default metadata or an unassigned Area from that parse failure.
- Verify that an external edit appears on Refresh and that an external rename resolves to the current path without showing both rows as a complete inventory. If the view is still inconsistent after a bounded read retry, report incomplete inventory. Desktop’s coverage can omit hidden notes.

## 4. Delete BB’s vault index

- Use Desktop’s inventory and metadata for property-filtered and path-glob searches, note metadata and internal link resolution. Use bounded on-demand reads where the caller needs source text, such as checking malformed frontmatter or returning a heading. Preserve access checks and report incomplete coverage when Desktop omits data.
- Delete BB’s separate vault-wide note index, its watcher and cached note and link data, and the Projects cache built on it. Use Desktop as the shared source of vault metadata. Request-scoped results and pagination can hold data for the active operation.

## Done when

- The enabled plugin runs one Desktop process and ordinary note operations use it through their normal BB entry points.
- GTD inventory and status changes work through generic Obsidian operations. Obsidian code and RPCs do not interpret projects, Areas or their properties. Verify an interrupted GTD status change can still resume from the recorded file-level outcome.
- Exercise a direct cross-folder note move and a folder move in Desktop with automatic link updates enabled. Check the destination, representative inbound links, refusal of an occupied destination, and inspection of an interrupted request. Both moves run without a separate preview or BB link scan.
- BB’s vault index and watcher are gone. Verify property and path-glob searches, note metadata, and internal link resolution through their normal tools, including incomplete coverage.
- The migrated implementations and their obsolete tests are gone. The Obsidian plugin must have fewer production lines of code than at `b6b7992`, counting the new Desktop integration and any plugin code moved elsewhere. Use the same counting method before and after, exclude generated files and dependencies, and report test LOC separately. Name the remaining callers of shared code that previously served the migrated operations. Test BB’s command mapping, error handling, access checks and lifecycle. Use a disposable real-app smoke test for the handoff to Obsidian.
- Projects uses Desktop in the normal sidebar, the parity checks above pass, and folders without landing notes are absent from the GTD inventory and sidebar. Compare repeated rendered fresh-client open, warm reopen and Refresh timings before and after on the same vault and host. The median for each must be no slower than the corresponding baseline. A parity or timing failure holds delivery until fixed. Compare warm note requests on the same vault and verify one fresh Docker setup with the documented host security settings.
- Apply the change to the actual local-path installation, verify a harmless read and iCloud scheduling, then publish the verified work. [Local-path delivery](../../CONTRIBUTING.md#local-path-development)
