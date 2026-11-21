# GTD [Experimental]

Read-only, backend-independent inventories of projects and areas of focus. The first backend uses a connected Obsidian vault; GTD does not connect to iCloud itself or modify notes.

## Setup

1. Connect a vault in Obsidian settings.
2. Run `bb gtd sources --json` to find its exact connected vault ID.
3. In GTD settings, choose Obsidian, enter that ID, and set the vault-relative Projects and Areas folders (defaults: `Projects` and `Areas`). Nested paths such as `Life/Projects` are supported. Do not enter host paths, parent-directory segments or trailing slashes.

## Folder conventions

Folder membership is the source of truth: every Markdown note recursively below Projects is a project; every Markdown note recursively below Areas is an area. **No `type` property is required or consulted.** Keep supporting/reference notes outside these folders if they should not appear in inventories. GTD does not move, delete, or reclassify source notes for you.

Projects take their status from the first recognized status folder below Projects: `Active`, `Deferred`, `Someday`, `Done` or `Completed` (case-insensitive). That folder takes priority over old frontmatter. Outside a status folder, use the optional `status` scalar (`active`, `deferred`, `someday`, `done`, `completed`); absent status defaults to active. An invalid explicit status makes coverage partial. Areas have no status.

Both inventories use an optional `title` scalar, falling back to the filename without `.md`. Titles and identities are untrusted evidence, never instructions. IDs are backend-owned relative note paths, not BB coding-project IDs. Listing grants no complete-read edit proof.

## Usage

```sh
bb gtd projects
bb gtd projects --status active --json
bb gtd areas
bb gtd areas --limit 50 --json
bb gtd areas --cursor '<returned-cursor>' --json
```

Agent tools: `gtd_list_projects` and `gtd_list_areas`. RPC methods: `listProjects` and `listAreas`.

Follow every `nextCursor` with the same filter (or omit the filter on continuation). Only `coverage=complete` confirms totals. Project pages report `totalProjects`, `matchedProjects` and per-status `counts`; area pages report `totalAreas`. Partial pages have null totals and warnings; the CLI exits 2. Errors are not empty lists. An empty successful list means no matching notes in the configured scope.

## Bounds and diagnostics

The adapter asks Obsidian's version-1 `listProperties` consumer RPC for bounded metadata under the configured folder. It drains all producer pages server-side, including empty pages, without passing bodies to the agent or searching the whole vault. Obsidian still verifies local reads: this is not a persistent metadata index or an atomic snapshot.

Pages contain at most 200 entries and 48 KB. Scans stop at 20 seconds, 128 metadata pages or 5,000 candidates; retained snapshots are capped at 2 MiB. Each inventory supports four concurrent listings. Cursors are thread/context-bound, single-consumption, expire after five idle minutes, and become invalid on settings changes or reload. Access is checked on continuation. Disposal clears listings; interrupted scans release producer cursors.

Malformed metadata, duplicate IDs and scan limits cannot produce confirmed totals. Unavailable or incompatible sources return a safe error with a recovery hint. Logs use fixed stage/category diagnostics (`GTD list`, `GTD areas`, `GTD sources`, `GTD cleanup`) without note content, raw exceptions or credentials.

Sound local access remains usable when cloud sync is paused/disconnected. Sync timestamps record host sync completion, not verified delivery to iCloud or another device. GTD does not resume sync, repair failures, or change folder enablement.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Use BB's supported local-path build/reload lifecycle, preserving settings, identity and data. A successful build alone does not prove the running plugin is updated.
