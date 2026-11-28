# Obsidian for BB

Connect one or more initialized iCloud mirrors, then ask BB to find, read, create
and edit Markdown notes. **Connecting grants read/write access to the whole
vault**, including nested and hidden folders. Installation connects nothing.
There are no folder permissions, read-only switches or per-edit confirmations.

```sh
bb plugin install obsidian@pa-for-bb
```

Follow the [setup guide](docs/setup.md). This is an independent BB plugin, not a
plugin inside Obsidian. Paired builds use the initialized mirror directory once
iCloud authorizes it. A mirror with pending legacy edits or legacy conflict
recovery continues to use the coordinated note interface. Use the [paired offline upgrade procedure](../icloud/README.md#upgrading-from-01x)
when upgrading from 0.1.x. It needs no Obsidian app, Mac relay or PA core. It supplies
assistant tools and connection settings, not a note browser, editor or graph.
Use only on single-user BB installations; BB plugins are full-trust server code,
not a per-user security boundary.

## Tools

Obsidian Desktop supplies note reads, search, metadata, links, tasks and moves
for the configured vault. BB keeps version-checked edits and iCloud conflict
recovery. Connecting a vault installs the pinned, checksum-verified Desktop and CLI bundle on Linux x86-64. See the [setup guide](docs/setup.md) for host requirements and optional overrides.

- Use `obsidian_search_notes` for literal text, nested tags, exact scalar
  frontmatter properties and POSIX path globs. Scope with `folders` or
  `excludeFolders`. Desktop-visible results can omit hidden notes. Follow every
  cursor. Use `totalMatches` only when the tool supplies it.
- `obsidian_get_note_metadata` includes source spans. With backlinks enabled,
  `backlinkSources` lists bounded referring filenames. Desktop does not
  report backlink occurrence spans. Use `obsidian_resolve_link` to follow an
  internal link from its source note.
- `obsidian_list_tasks` returns the exact task marker and location. A blank
  marker means incomplete. Use the version-checked `task` edit to change it.
- `obsidian_move_note` and `obsidian_move_folder` take exact paths and a fresh
  operation UUID. They run directly when automatic link updates are enabled.
  An occupied destination is refused. Obsidian rewrites links. Inspect the
  durable file outcome with `obsidian_move_status` before retrying an
  interrupted move.
- `obsidian_status` reports connected vaults, local access, sync and exact
  save or conflict evidence. `obsidian_create_note`, `obsidian_edit_note`
  and `obsidian_update_properties` use the checked behavior below.
- `obsidian_recover_receipts` inspects and settles proven outcomes by operation
  ID. See [receipt recovery and hourly activation](docs/receipt-recovery.md).

The BB plugin interface provides generic vault inventory, checked note-property
edits, path moves and receipts. The [GTD plugin](../gtd/README.md) interprets the
vault data for Projects and owns conversation associations.

## Complete reads and long notes

A short whole-note read returns `complete: true` in one bounded response. Longer
notes return ordered chunks and `nextCursor`. Call `obsidian_read_note` again with
the **same vault, path and incoming selector (if any)** plus that cursor. Continue
until `nextCursor: null`, including the **final empty acknowledgement** after the
last content chunk. Do not edit after the last nonempty page: it is still incomplete.

```json
{"vaultId":"VAULT_ID","path":"Projects/Checklist.md"}
{"vaultId":"VAULT_ID","path":"Projects/Checklist.md","cursor":"RETURNED_NEXT_CURSOR"}
```

`offset`, `nextOffset` and `totalChars` count UTF-16 code units. Concatenate `text`
exactly, without separators: BOM, Unicode and original LF/CRLF endings are retained.
Every page carries the same SHA-256 whole-note `hash` and `totalBytes`. The source
is reread and its complete bytes/hash verified for each page and the final
acknowledgement. Text is not cached as a second note store. The parser runs once
per read sequence; continuation checks reuse its warnings only for the same hash.

**Complete means all original text for one hash has been returned in order**,
not that a section, search, semantic parse, cloud sync or device delivery is complete.
Only `complete: true` **and** `editReady: true` issue an ordinary edit proof to the
reading BB thread. The final empty response acknowledges the preceding content
page; a cursor is a single-use continuation receipt, not an arbitrary offset.
Missing, skipped, reused, wrong-thread, expired or failed continuations cannot
finish a read. Restart a fresh whole-note read after any failure or lost response;
never manufacture an offset/cursor or combine different read sequences. Bounded
JSON serialization is checked before issuing a cursor or proof. This is a tool
protocol guarantee, not proof that a provider retained all text in its context
or that a human understood it.

Heading/block reads remain bounded excerpts, with no continuation or ordinary edit
proof. Incoming reads can continue, but **never** issue ordinary edit proof; their
conflict token is revalidated each page. Incoming absence remains explicit and
incomplete. Configuration changes, restart, local safety changes, note/hash changes
and cancellation fail closed. Cloud progress alone does not revoke a read. Ordinary
writes still reread the note and use iCloud's authoritative CAS; pending/uncertain
mutation recovery is unchanged. Another thread reading the same note can replace
the bounded in-memory proof, in which case reread in the editing thread.

Raw notes remain limited to 1 MiB. Text above the independent 64 KiB semantic-parser
bound can be read completely with `parser_limit`, but `editReady` remains false.
Paging does **not** widen parser/write limits, authorize an unsupported edit, truncate
a note or restructure its checklist. Malformed properties and other write checks
remain enforced by the existing parser before saving.

## Source and save guarantees

- iCloud owns Apple setup, mirror storage and native sync. It grants directory
  access only to the host-verified Obsidian plugin and checks the current
  connected vault revision and mirror identity. Tools and inventories expose
  vault-relative paths. Saved vault selections keep their existing IDs.
- iCloud enables filesystem access after the mirror has finished initialization
  and cleared pending legacy writes and recovery. It fences legacy writes
  before granting directory access. Pending and conflicted legacy mirrors
  remain on iCloud’s coordinated file interface, where existing operations can finish or be
  resolved. Historical receipts remain available.
- Sound initialized mirrors can be available while cloud sync runs or is
  paused, or while Apple is disconnected. The last-success timestamp is when
  a host sync operation returned successfully. Report it in the user's time
  zone. A null timestamp means no successful sync was recorded.
- A replacement requires a complete whole-note read in the same BB thread and
  its SHA-256 hash. Obsidian rechecks authorization and current file identity
  and bytes before publishing. On a filesystem mirror, creation is exclusive
  and replacement installs a staged file atomically. Concurrent changes from
  the sync process or another writer can still occur between filesystem
  operations.
- Desktop metadata can lag a file changed outside Obsidian. Exact-path conflict
  inspection finds native conflict copies on disk. An unambiguous pair can be
  resolved with the existing guarded choice. The resolution writes the chosen
  text to the canonical path and removes the inspected copies. An ambiguous
  set requires inspection in the vault directory. A missing canonical file
  alone does not establish incoming absence.
- Conflicts resolve themselves. When iCloud finishes a scan of a connected
  vault, and every five minutes as a fallback, Obsidian looks for sync
  conflict copies and settles up to 20 per vault:
  - A note where one copy only adds lines keeps that copy, without a model.
  - Any other note pair is merged by a hidden, short-lived BB agent thread. The
    merge is applied only if it keeps every line both copies share. It goes
    through the same guarded resolution, receipt and push as a manual choice.
  - A file that isn't a note, such as `.obsidian/workspace.json`, keeps its
    newest version.
  Removed copies reach iCloud's Recently Deleted through the next sync. A
  conflict that can't be settled, such as an ambiguous set, a note over 60,000
  characters or a rejected merge, is left in place and retried after an hour.
- Durable filesystem receipts record operation IDs, hashes and inode evidence
  in Obsidian's private storage. They contain metadata only. Uncertain
  operations are inspected by ID without replaying the file mutation.
- A confirmed result means **saved locally, pending iCloud sync**. A later sync
  timestamp does not verify those bytes in iCloud or on a phone. Never repeat an
  edit just because its later sync failed. Use `obsidian_status` to inspect a lost
  reply by its persisted exact ID, vault and path, independently of the recent page.
- Remove invalidates content proofs/cursors and revokes content/receipt exposure.
  The producer must accept the revoking revision before removal is confirmed. A
  lost configuration reply stays unconfirmed and must be checked again. A local
  save accepted before revocation is not undone. Removal does not delete notes, pause sync or disconnect Apple.

## Supported Markdown subset

The [reference index](docs/reference/README.md) links to Obsidian Help and the
developer docs and includes pinned MIT API declarations.
`mdast-util-from-markdown` 2.1.0 and `yaml` 2.9.1 supply maintained parsers.
They provide source spans and prepare checked text and property changes.

The parser retains original UTF-8 text and source offsets, including BOM, Unicode
and LF/CRLF endings. It extracts headings, inline/standalone block IDs, wikilinks,
Markdown links, embeds, body/property tags and list tasks. Code, `%%` comments and
HTML regions do not supply body links/tags/tasks; callout Markdown still counts.
A blank task marker is incomplete; any nonblank marker is complete, with its
original marker retained. No community-plugin task states are invented.

Links resolve within the explicit source vault: explicit root/relative paths,
otherwise a unique filename candidate. Bare duplicate filenames are ambiguous;
use an explicit path. External links are not fetched. Aliases are metadata, not
a promise of alias-based or full Obsidian resolution. Embeds remain references.

Properties support a top-level YAML mapping of finite scalar values and scalar
lists. `aliases`, `tags` and `cssclasses` must be string lists; tags and date/time
strings are validated. Quoted internal-link strings are supported. Duplicate keys,
custom tags, aliases/merges, nested maps and malformed YAML are readable with a
warning but cannot be written. General text edits cannot bypass that validation.
Structured changes preserve unrelated comments, spacing, headers and body bytes;
unsupported structural edits fail rather than rewrite the document. Removed
property tags are named in the change result. This does not infer vault-wide types.

## Resource and recovery limits

| Boundary | Limit |
| --- | --- |
| Connected vaults | 20 |
| Raw note | 1 MiB, valid UTF-8 regular lowercase `.md` files; relative paths up to 1,024 characters; no symlinks/traversal |
| Semantic parser / writes | 64 KiB UTF-8, 20,000 nodes and depth 64 |
| Output | At most 48,000 UTF-16 units per read chunk, reduced to fit a 60,000-character serialized read envelope (including JSON escaping); final tool result capped at 64,000 characters; metadata collections capped at 100 items |
| Whole-note read continuation | Four in-memory sequences including in-flight continuation reservations (all busy refuses new sequences), five-minute idle / thirty-minute absolute lifetime; single-use thread/target/selector-bound cursors, with final empty acknowledgement; no section pagination |
| Search and task pages | Default 20, maximum 50 rows. Up to ten one-minute result cursors, bound to the configuration and rechecked for vault access. Desktop commands cap stdout at 8 MiB and inventory at 10,000 entries. |
| Save conflict-copy inspection | At most 10,000 siblings; larger/ambiguous sets refuse with uncertainty. This separate save-safety bound is not a search cutoff |
| Complete-read proofs | 256 in-memory note versions, bound to the reading thread; issued only after bounded complete delivery without parser-limit warnings, invalidated on the affected note save, configuration change and restart |
| Filesystem operation receipts | Append-only SQLite history with an indexed unresolved projection. Unresolved operations block overlapping paths. |
| Recovery tool | Ten local operation IDs per page. Evidence tokens expire after five minutes and are bound to the operation, configuration, and requesting thread. |
| Legacy recovery | Existing iCloud recovery data and limits continue to apply to legacy operations. |

Receipts record past operations. Use a fresh read for current bytes.
Use filesystem or iCloud history for previous versions of filesystem-backed
notes when history is available.

### Operator-assisted restoration

1. Preserve the current note and the relevant private operation record before
   investigating. Keep these copies outside all synced mirrors and private to the
   service account; do not print their contents or paths in public diagnostics.
2. Review the receipt, expected hashes and current complete note. Check any
   previous versions available in legacy recovery or filesystem backups. Use
   inode evidence to investigate uncertain filesystem operations.
3. Ask which version or merge should be restored. Preserve newer changes separately.
   Prepare the desired content against a fresh complete read and its current hash.
4. For an active conflict, inspect the exact path/token and guarded incoming
   content or absence with `obsidian_status` / `obsidian_read_note`. Choose keep
   local, accept incoming or an explicit replacement through `obsidian_edit_note`
   with the expected logical/incoming versions. A stale token needs fresh inspection.
   Resolving filesystem conflict copies removes those copies from the local
   mirror. Later sync can propagate their removal.
5. Report the new local-save receipt separately from sync/device delivery. Do not
   reset native baselines, clear locks or force resync merely to restore a note.

## Development and evidence

```sh
npm ci
npm run typecheck
npm test
# In an isolated running BB (synthetic RPC views, real host rendering):
BB_REVIEW_BASE=http://127.0.0.1:PORT node test/rendered-review.mjs
```

The hexagonal core has catalog, file, parser and state ports. Cucumber examples
use generated multi-vault data; adapter/host/lifecycle tests use synthetic private
sentinels. Handled failures log fixed `Obsidian <stage> <category>` messages, never
note content, credentials, account details, roots or raw exceptions. A passing
connection flag is not proof of a successful read or cloud delivery.

The [iteration release evidence](../../docs/plans/006-obsidian-vault-reading.md#release-evidence)
separates local tests, Linux native ownership/crash tests, actual BB/provider
observations and installed-release checks. Apple and phone writes need separate
specific authorization; generated-data tests do not establish those round trips.
