# 029 — Stable project and Area identity in Obsidian

A project's filename provides its display name. Its immediate status folder controls its status. Existing root projects keep their legacy status rule. An Area landing note takes its name from its filename. Preserve the configured Projects and Areas folders and the positions of all notes and support folders.

New landing-note IDs use `project-<guid>` or `area-<guid>`, with a lowercase UUID v4 as the GUID. Set the top-level `id` once at creation or during an explicitly approved migration. IDs already assigned with an underscore retain their exact values in notes, assignments, routes and thread links. GTD resolves the ID within the configured vault scope and reports the current `notePath` separately. The stable value in a project's top-level `area` is the assigned Area's ID. A supporting note does not become a landing note by declaring an ID.

## Preview

Use `bb gtd migration-preview --json` in the selected source. Keep the report private. Preview reads Obsidian inventory and checked note versions, and examines active, hidden and archived BB threads for both project and direct Area associations. The only writes are reservations and the reviewed manifest in GTD's private storage. The report contains the current and proposed identity, note location, Area declaration, thread mappings and legacy route aliases derived from those rows. It cannot enumerate a user's actual browser bookmarks.

A format upgrade gives unassigned legacy reservations new hyphen IDs that repeat across previews. Re-run and review previews saved before this upgrade before starting apply. An already-started apply continues from its original reviewed manifest and receipts.

Coverage and resolution are separate. Invalid YAML and unavailable evidence produce partial coverage. Missing landing pages, duplicate or malformed IDs, nested Area targets, invalid declarations and unmatched historical references require review. A folder-only Area has no stable landing ID. A referenced historical project folder or supporting note is unresolved. The migration does not create notes, promote support files, move directories, or change an assignment to its enclosing Area.

For a prior move or rename, supply the kind, old ID, exact checked operation ID and baseline hash in `--renames`. A retained move receipt with its checked old hash, or a retained preview supplied as `priorPlanId` plus the matching move receipt, can establish the mapping when the destination still has that version. A checked mapping takes precedence if the old path was reused. Missing evidence leaves the relationship unresolved. A legacy reference at its current exact path is reviewed as an observed association. For any known path reuse before that review, supply historical evidence before applying; a current path alone cannot establish who occupied it previously.

## Apply and verify

The first handoff is the read-only preview. A separate operator instruction is required before applying to any real vault. Review the exact plan ID, all rows and mappings, and any findings before applying. Use an exclusive window for Obsidian changes and GTD associations. GTD gates its own write surfaces and drains admitted work. BB's metadata API has no conditional-update parameter. Independent changes during this window can invalidate the preview or require reconciliation.

`bb gtd migration-apply --plan <id>` rechecks the reviewed note versions, identities and reference set. Pending legacy move, deferral or reactivation work must be reconciled first. Each property save uses the checked hash and a recorded operation ID. The runner verifies saved versions and updates only the named project or Area metadata key. Creation receipts and unrelated metadata are preserved. After an interruption, inspect `bb gtd migration-status --plan <id>` and the listed Obsidian receipts. Resume the same plan. An uncertain write with no confirmed outcome requires reconciliation.

GTD publishes stable mode for that selected scope only after verifying the resulting inventory, Area assignments and thread references. The V2 inventory and current agent tools report identity mode. Legacy read RPCs and default CLI lists retain path-shaped IDs. New bookmarks use stable IDs. Old bookmarks use scoped, kind-checked aliases from the reviewed manifest. The same path occupied by a different note does not take over the alias. Missing or ambiguous stable IDs remain unavailable. Keep a migration-capable reader and its manifest available for recovery. An older build cannot interpret migrated associations by itself.

## Verification

Use a disposable BB instance and generated vault and threads. Rehearse duplicate identities, stale previews, revoked access, unresolved legacy references, interrupted note and metadata saves, and creation request replay. Rename a project and an Area in the fixture, move the project into a status folder, and place a different note at its former path. Check the same active and archived links and Area assignment, both generations of bookmarks, the legacy reader projection, and bounded diagnostics. Confirm that stable inventory adds no per-note lookups to ordinary browsing.
