# 031 — Make Obsidian Desktop the note backend

BB should ask Obsidian Desktop to work with notes, then delete the BB code that does the same work. Desktop starts when the Obsidian plugin is enabled and its vault is available. It stays running until BB unloads the plugin. iCloud continues to sync the same local vault. BB continues to own the Projects sidebar and its conversation links. [Iteration 030](030-obsidian-desktop-links.md)

## 1. Start Desktop with the plugin

- Replace the per-request launch and quit with one owned Desktop process, a private profile and a private CLI socket. Start it once the configured vault is available. If setup is missing or startup fails, show the reason when a command needs Desktop. Preserve the connected vault and its iCloud state.
- Use the existing direct vault grant and the official Linux binaries. Preserve restricted mode. The selected vault is operator-controlled and uses ordinary files and folders. Check the fresh-machine Docker setup and update provisioning only for demonstrated missing dependencies. [Docker setup](../../docker/README.md#optional-obsidian-desktop-cli)
- Exercise enable, disable, reload, BB restart and a Desktop crash. Check for one process tree, no leftover socket or child, and a usable first request. A failed or interrupted write has an unknown outcome until inspected. Starting Desktop again must never replay that write.

On a small disposable vault, Desktop took 1.16 seconds to start and used about 342 MiB while running. Warm read, search, property, task and backlink commands took about 1–2 ms each. Recheck with a representative vault and measure BB request time as well as the CLI call.

## 2. Move ordinary note operations to Desktop and delete the old BB code

- Replace BB’s implementations of backlinks, ordinary same-folder rename, plain note reads, text search, task listing and status changes, and supported single-property changes with the corresponding native commands. Use native results and error behavior where compatible. Open each vault and note by its exact authorized identity. Keep tool names where the request and result still mean the same thing. [Official CLI](https://obsidian.md/help/cli)
- Switch each tool once its main use cases work, then remove the old branch and its tests. Remove `desktop_rename` as a separate choice when ordinary rename uses Desktop directly. While Desktop is unavailable, report that state for migrated commands. Do not keep a second implementation behind a fallback.
- Check callers of exact text replacement, multi-property saves, conflict recovery, cross-folder moves, and GTD status changes before changing those contracts. Keep a small BB implementation where it protects an outcome a current caller needs, such as recovering an interrupted GTD status change. Record the concrete reason for each piece that stays.

## 3. Try the Projects screen without BB’s note index

The sidebar needs project and Area paths, project title and status, and the `area` property so BB can group the result and attach conversations. In a disposable vault with 135 projects and 13 Areas, one fixed query using Desktop’s public Vault and MetadataCache APIs returned the needed note data in 2.7 ms. BB reproduced all 76 baseline Area assignments from those rows. A separate read on the live sidebar measured 184 ms from click to usable. These timings measure different work.

- Prototype one bounded Desktop query using the existing vault authorization. Prefer an official command. The tested alternative is one BB-owned fixed expression calling public APIs through the documented CLI. Keep the expression fixed and avoid private app methods. Apply BB’s existing project ownership, status, Area grouping, and conversation rules to the result.
- Test actual Projects open, reopen and Refresh on the same inventory before and after. Compare project and Area IDs, folder-only projects, assignments, and conversation links. Check what the sidebar shows after a note changes or is renamed outside Desktop. Hidden notes can be omitted. On the test vault, broken YAML looked like missing properties, and Desktop briefly showed both filenames after an external rename. Decide how to present those two cases before changing the live source.
- Inventory every remaining user of BB’s index. Remove the watcher, stored note data and Projects-specific cache when their last callers move. If one still serves an outcome we need, name the caller and measure the benefit of the proposed change before keeping two copies of vault data in service.

## Done when

- The enabled plugin runs one Desktop process and ordinary note operations use it through their normal BB entry points.
- The migrated code and its obsolete tests are gone. Compare production and test size with `b6b7992` and list the BB code still needed and why. Test BB’s command mapping, error handling, access checks and lifecycle. Use a disposable real-app smoke test for the handoff to Obsidian.
- Compare warm note requests and the rendered Projects timings before and after on the same inventory. Projects keeps its current data source if the replacement cannot meet the agreed behavior and performance. Verify one fresh Docker setup with the documented host security settings.
- Apply the change to the actual local-path installation, verify a harmless read and iCloud scheduling, then publish the verified work. [Local-path delivery](../../CONTRIBUTING.md#local-path-development)
