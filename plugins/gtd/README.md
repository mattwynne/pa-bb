# GTD for BB

Read-only GTD project inventories, independent of where projects are stored. The first adapter reads **connected Obsidian vaults**. This is not a list of BB coding projects, and it does not create or edit projects.

## Setup

Requires Node 22+, BB 0.49+ with Plugin SDK 0.6.132+, and the updated Obsidian plugin exposing `propertiesAccessVersion: 1`. Obsidian currently uses the iCloud plugin and its normal local-access safety checks. No Obsidian application is required. GTD cannot open arbitrary filesystem paths or disconnected vaults.

This experimental package is available from source, not yet listed in the marketplace:

```sh
npm ci --prefix plugins/gtd --include=dev
bb plugin build plugins/gtd
bb plugin install ./plugins/gtd
```

1. In BB's **Obsidian settings**, connect your initialized vault.
2. Run `bb gtd sources` (or `--json`) to find its exact connected vault ID. This shows local availability, not proof that project listing works.
3. In **GTD settings**, select Obsidian, enter that vault ID, and set the vault-relative Projects folder. The default is `Projects`; a nested folder such as `Life/Projects` is supported. Do not enter a host path or trailing slash.
4. Run `bb gtd projects`. Start a fresh agent session to discover `gtd_list_projects` and the GTD skill.

The same configuration can be set with the supported CLI:

```sh
bb plugin config gtd set vaultId '<vault-id-from-sources>'
bb plugin config gtd set projectsFolder 'Projects'
```

An unavailable source is an error, not an empty list. An empty successful list means no matching project notes were found under the configured folder; check that folder and the conventions below if unexpected.

## Project convention

Each project is a Markdown note below the configured Projects folder, with YAML frontmatter:

```markdown
---
type: project
status: active
title: Launch the community garden
reviewed: 2026-11-20
---

# Launch the community garden

## Outcome
The garden is open and its volunteer rota is established.
```

- `type: project` identifies a project, even when it lives in a nested folder.
- `status` is required: `active`, `deferred`, `someday`, or `done`. `completed` is accepted as an alias for `done`. Values are case-sensitive. Folder names never override status.
- `title` is optional, a single-line string of 1–240 characters. The filename without `.md` is the fallback. Other metadata and body headings are not used for naming or classification.
- `reviewed` is an optional convention, not currently interpreted by GTD. Task extraction, review reminders, outcomes, edits, and arbitrary status mappings are outside this first version.
- Use plain top-level YAML scalar properties (or scalar arrays); aliases, custom tags, nested maps, duplicate keys, and oversized frontmatter are not supported by the current Obsidian metadata parser. A parsing omission makes the result partial.

**Existing status-only notes:** without `type`, a note is also a project when it has a recognized status and lives directly in Projects, or directly in `Active/`, `Deferred/`, `Someday/`, or `Done/` immediately below it. Deeper supporting notes need `type: project` to count. An explicit different type always excludes a note. This compatibility rule is deliberately narrow: meeting notes and reference material are not projects just because they have a status.

Identity is the backend's source ID plus its project ID; for Obsidian, that means vault ID plus exact relative note path. Duplicate titles remain separate projects; duplicate IDs are reported as incomplete rather than counted twice. Renaming a note changes its ID in this version. No migration or note rewrite is performed.

## Commands and agent tool

```sh
bb gtd sources                         # Connected Obsidian vault IDs
bb gtd projects                        # All statuses, grouped and alphabetized
bb gtd projects --status active
bb gtd projects --status someday
bb gtd projects --status done
bb gtd projects --json                 # Structured result
bb gtd projects --limit 50 --json
bb gtd projects --cursor '<cursor>' --json
```

`gtd_list_projects` accepts `status`, `limit`, and `cursor` with the same meanings. `status` defaults to `all`; `limit` defaults to 200 (1–200). A page may contain fewer projects to keep output below 48 KB. Continue every `nextCursor`, omitting the filter or keeping it unchanged. Totals describe the full listing, not just the current page. The text output includes project IDs as source references; Obsidian IDs can be read with the ordinary note tools.

CLI exit codes: **0** complete read, **2** partial listing, nonzero for errors. JSON partial output remains a listing with `coverage: "partial"`, warnings, and null totals/counts. Error output uses BB's standard CLI error envelope. Never treat a failed or partial read as zero projects.

## Performance and limits

The adapter asks Obsidian for only `type`, `status`, and `title` under the configured folder. It drains producer pages on the server: the agent does not discover the vault, search the entire vault, read individual bodies, or make one tool call per project. Obsidian still verifies local source reads; this is a scoped scan, **not** a persistent metadata index or an atomic vault snapshot.

Each new inventory reads the source again. Pagination retains that inventory in memory and rechecks access/settings, rather than rescanning it. Four listings can be open concurrently; cursors expire after five idle minutes, on plugin reload/disposal, or when settings change. Agent cursors are bound to the calling thread; CLI cursors should be continued from the same thread/context. The adapter caps scans at 20 seconds, 128 metadata pages, or 5,000 candidates, and core caps each retained snapshot at 2 MiB. Limits and omitted/malformed metadata produce partial results, not confirmed totals. Access, transport, or invalid-response failures produce errors. No background jobs, durable project cache, or filesystem fallback are created.

Local availability is independent of cloud connection or pause state. Sound local notes remain usable when sync is paused/disconnected. `lastSuccessfulSync` reports when the host sync operation returned successfully; null means no recorded success, not verified delivery to another device. Listing does not resume sync or repair failed folders.

## Architecture and verification

`core/model.ts` defines the project model and `ProjectBackend` port. `core/projects.ts` owns filters, counts, ordering, bounded output and pagination. `adapters/obsidian.ts` owns RPC validation, vault paths, frontmatter conventions and status normalization. A new backend implements `readProjects` and `checkAccess`, returning the same validated snapshot; it does not need to know about Obsidian or YAML. The factory is the composition root, not an adapter registry exposed to agents.

Obsidian provides generic `listProperties` / `closeProperties` consumer RPCs. They return selected metadata only, obey connected-vault safety, and confer no complete-read proof for edits. GTD contains no iCloud, Apple credential, native sync, or note-writing logic.

```sh
npm --prefix plugins/gtd test
npm --prefix plugins/gtd run typecheck
npm --prefix plugins/gtd run build
```

Tests cover a second fake backend, classification, scoping, pagination, empty/partial/error outcomes, access revocation, cancellation, public SDK usage, CLI/tool/RPC behavior and diagnostic redaction. Warnings log only a fixed GTD operation/category, never project names, paths, account content or raw exceptions. A live read and bounded log inspection are still required to establish that an installed source works; unit tests alone do not prove cloud delivery.
