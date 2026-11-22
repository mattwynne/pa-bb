# 5. Give each Obsidian vault index one writer

Date: 2026-11-21

Status: accepted. Builds on [ADR 0003: ports and adapters](../../../../docs/adrs/0003-layered-hexagonal-testing.md).

## Context

Repeated metadata queries, such as listing active projects, should not have to reread every note. [Plan 016](../../../../docs/plans/016-ripgrep-vault-search.md) chose live traversal for search. Path-glob and frontmatter queries on connected filesystem vaults may now lag even a successful local save. Other queries, including tag-only and body-text searches with metadata filters, keep their existing route. Legacy logical vaults are unchanged.

A slightly old answer is acceptable. An internally inconsistent one is not: if a refresh replaces an old name with a new one, a reader must not see half of that publication. Missing one side of a rename can still leave stale paths until reconciliation. A filesystem notification can arrive during a scan, or never arrive at all.

## Decision

Use one actor per vault as the sole writer of its in-memory read model: directories, note paths, content hashes and parsed metadata, not note bodies. An actor here means an owner that processes one refresh request at a time, not a requirement for a particular framework or thread. Serializing writers prevents a slow full scan from overwriting a newer path refresh without requiring competing writers to merge results.

The watcher and timer are inbound adapters. They request a check of a path, directory or whole vault; they do not command a change to the model. The actor reads through the authorized vault port, prepares changes privately, and publishes an immutable snapshot in one step. Requests arriving during a scan remain pending. Repeated hints may be combined because the writer checks the current filesystem, not the historical event payload. A full scan at startup and every five minutes reconciles missed events.

The first query waits for initial publication. Later queries do not queue behind a healthy refresh: each reads one published snapshot per vault, including across pages. There is no common observation time across vaults. If a required file read fails, report the error and publish nothing. Snapshots are not authorization to read or edit a note; loss of vault access invalidates them. Start an index only when the separate `mirrorDirectoryCapabilities(null)` RPC returns `mirrorDirectoryGrantVersion: 1`; leave the strict legacy `status` reply unchanged. The provider returns the directory and the device/inode from its validated binding. The actor verifies the identity on the descriptor it uses for traversal and watches, never a path reopened after validation. A failed capability check or denied/mismatched grant does not fall back to path-only access. A valid reply without the capability or the SDK's typed missing-method reply keeps existing live routes.

## Consequences

**Easier:** Readers and writers can overlap without readers observing half an update. The same refresh rules handle local edits, sync and missed notifications. The filesystem remains authoritative; the index can be discarded and rebuilt.

**Harder:** Full scans consume I/O even when nobody queries. Startup queries wait, and a long scan delays queued refreshes. The five-minute interval is not a freshness guarantee. Old snapshots held by paginated readers cost memory and need bounded lifetimes. Cap current views, active builds and cursor-retained views separately so a full current-view budget does not prevent a same-sized replacement. Publication is atomic within the plugin, not across the files observed during a scan.

**Alternatives:** Live traversal avoids maintaining shared state but repeats discovery and reads for every query. A shared mutable index under a lock could also protect readers, but holding a read lock across pages would delay refreshes; releasing it between pages would allow mixed answers. Publishing snapshots accepts extra memory to avoid that coupling.
