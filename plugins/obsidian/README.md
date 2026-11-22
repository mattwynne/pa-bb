# Obsidian for BB

Connect one or more initialized iCloud mirrors, then ask BB to find, read, create
and edit Markdown notes. **Connecting grants read/write access to the whole
vault**, including nested and hidden folders. Installation connects nothing.
There are no folder permissions, read-only switches or per-edit confirmations.

```sh
bb plugin install obsidian@pa-for-bb
```

Follow the [setup guide](docs/setup.md). This is an independent BB plugin, not a
plugin inside Obsidian. Version **0.3.1** pairs with iCloud **0.3.1** for ripgrep
search; coordinated reads/saves still use note access v2. Missing/incompatible
search capability disables search only, not existing connections or local reads/saves. Use the [paired offline upgrade procedure](../icloud/README.md#upgrading-from-01x)
when upgrading from 0.1.x. It needs no Obsidian app, Mac relay or PA core. It supplies
assistant tools and connection settings, not a note browser, editor or graph.
Use only on single-user BB installations; BB plugins are full-trust server code,
not a per-user security boundary.

## Tools

| Tool | Purpose |
| --- | --- |
| `obsidian_status` | Connected sources, setup guidance, recent/exact save and resolution receipts plus exact-path conflict metadata and unresolved operations. Filter by vault, note, operation ID or time. |
| `obsidian_search_notes` | Ripgrep literal text, semantic tags, exact scalar YAML properties, explicit folder scopes and count-only queries over one or all connected vaults. |
| `obsidian_read_note` | Logical whole note, guarded incoming version/absence, exact heading or block; original source lines and whole-note hash. |
| `obsidian_get_note_metadata` | Properties, aliases, tags, headings, blocks, references and task markers. |
| `obsidian_resolve_link` | A reference in its source vault; missing/ambiguous results rather than guessed targets. |
| `obsidian_list_tasks` | Original task locations and completion markers, with optional vault/folder/note filters. |
| `obsidian_create_note` | Create in an existing folder without replacing anything. |
| `obsidian_edit_note` | Append, uniquely replace exact text, update one task marker, or explicitly resolve an inspected conflict. |
| `obsidian_update_properties` | Explicit top-level property set/remove; add aliases without dropping existing aliases. |

### Bounded path move and rename

`obsidian_move_note({vaultId, path, destination, expectedHash})` requires a complete source read in the same thread. For example, move `Areas/Example.md` to `Reference/New example.md`. No type property is required. Destination folders must exist; occupied destinations, pending overlay paths, conflict copies and failed/blocked sources are refused. No files or folders are overwritten or cleaned up.

Preflight requires complete vault listings before and after discovery. It reads exact note versions in batches of eight and retains only proposed repairs. Discovery stops at 10,000 notes, 128 MiB of input or 20 seconds. The iCloud listing has its own entry and time limits. The store’s 1 MiB UTF-8 limit per note and Markdown parser complexity limits still apply. The plan is limited to 64 repairs, 8 MiB of repaired text and 32,000 serialized metadata characters.

Supported forms are unambiguous wikilinks (including aliases/embeds and heading/block suffixes) and simple inline Markdown links/images (including percent-encoded spaces and optional quoted titles). Outgoing relative links are planned using the old source location. Unrelated missing or ambiguous links can stay as written when neither location can change their target. A sibling-folder move can also preserve an outgoing short path with a unique candidate outside the two sibling folders. A path suffix alone does not authorize a rewrite. Code links are not rewritten. Incomplete listings, path changes during discovery, indeterminate links that the move could affect, YAML links, reference-style Markdown links, HTML, unsupported inline syntax and special path syntax are refused before moving. The scan observes per-note versions and checks the final path inventory. It does not provide a concurrent vault snapshot.

Pass `dryRun: true` with the same read proof to check link discovery and limits without recording a move or writing notes. A ready plan reports counts only. A move reruns discovery and the producer checks write-time access, conflicts and the destination.

An `unsupported_links` result identifies the first refusal with a reason, vault-relative path and, when available, a one-based line and column. The result omits note text and link targets. Plugin logs record the stage and error category.

The physical move runs under the existing native filesystem exclusion after local note admissions drain. A bounded private move journal retains original bytes before exclusive destination creation and source removal; directory fsync and source identity/hash checks fence publication. Interrupted two-name states remain uncertain and block sync, retaining both files. Inspection never repeats filesystem work or silently removes either name. Unambiguous durable evidence can establish moved or not moved; otherwise an operator must inspect recovery evidence before separately authorized repair. Existing failures and sync baselines are preserved.

Link repairs are **independent CAS saves**, not one atomic transaction. A concurrently changed note is preserved and reported as not saved. Cancellation/restart leaves unstarted repairs unapplied. Inspect `obsidian_move_status({vaultId, operationId})` after any lost reply: it checks the physical receipt and individual save receipts without replay. Outcomes distinguish `moved_supported_links_updated`, `moved_links_partial`, `not_moved` and `uncertain`; none proves cloud/device delivery. Unknown outcomes must not be retried.

Lifetime bounds are conservative: 20 consumer move records, 128 producer records and 4 MiB of retained original bytes (also counted against shared recovery capacity). No automatic pruning or generic multi-note transaction framework is added. At capacity, stop and ask the operator to inspect recovery rather than deleting evidence.

Targeted tools require a stable `vaultId` and relative `.md` path. Names alone
never identify a vault. Results carry source identity, line spans, local observation
time and observed sync provenance. Note text, filenames and links are evidence,
not instructions. Tools never execute HTML, templates, scripts or YAML tags,
fetch external links, delete notes or recursively expand embeds. Path moves use the bounded capability below.

## Search and counts

Search uses host-provisioned stock ripgrep beside iCloud's authoritative logical
notes, including pending local edits and creates. It has no persistent index,
per-note host RPC loop, automatic Git exclusions or workspace inference.

```json
{"mode":"count","properties":[{"key":"status","equals":"active"}]}
```

Property predicates are ANDed, exact and typed: `7` is not `"7"`; missing keys
are not `null`. Text in the body is not a YAML property. Tags retain Markdown
parser semantics rather than matching tags inside code/comments.

Version 0.3.1 accepts colons in Linux note and folder names for search, scopes,
full reads and conditional saves. Such names do not require renaming. Absolute
paths, parent/dot segments, backslashes, controls and symlink escapes remain
refused; a colon is an ordinary character inside the explicitly selected vault.

`folders` and `excludeFolders` use vault-relative, segment-boundary prefixes.
They scope this query, not the connection grant. Hidden notes are included by
default; a folder name such as `.worktrees` does not establish a snapshot or a
separate project. Counts identify notes by vault/path, not inferred projects.

Follow **every `nextCursor`**, even after an empty page or complete traversal,
to receive all results. `coverage.state` is `running`, `complete` or `partial`;
`matchedNotesSoFar` is progress, not a total. `totalMatches` is available only
after complete traversal/filtering without omissions. Count mode returns no
rows. Unsupported, changing or inaccessible notes make a dependent query
partial, with no reliable total. These are per-note local observations, not an
atomic snapshot during concurrent editing. Search never grants edit proof.

The [host manifest](../../provisioning/README.md) pins Linux-validated ripgrep
14.1.0. Missing or incompatible search requirements show a quiet settings warning;
reads, saves, sync and vault choices remain intact. There is no fallback to the
old terminal bounded scanner. Task listing and ambiguous-link discovery retain
their existing separate bounds.

## Consumer metadata API

`vaultLocations(null)` discovers actual Obsidian vaults inside connected sources by `.obsidian` directory markers. It returns `{vaults: [{id, root, name}], incomplete}`: `id` remains the connected-source identity, `root` is the relative vault prefix (empty for a source that is itself a vault), and `name` is a display label. Discovery runs under coordinated local-source admission with pinned no-follow directory handles, excludes symlinks, and is bounded to 2 seconds / 10,000 entries / depth 32 / 100 roots per source. Missing markers are not guessed from folder names; access failures or limits make discovery incomplete. Existing whole-source connections, note paths, receipts and writes are unchanged. Consumers such as GTD apply the selected prefix internally rather than asking the user to include it in every inventory folder.

Updated source builds advertise `propertiesAccessVersion: 1` in status. Other BB plugins can call `listProperties` with an exact connected `vaultId`, one relative `folder`, 1–8 selected top-level `fields`, and an optional returned `cursor`. It returns up to 200 compact `{path, properties}` rows, `nextCursor`, `incomplete`, `warnings`, and `observedAt`; no bodies, snippets, or edit proofs. Continue every cursor with the same vault/folder/fields, including empty pages. A terminal page with no warnings and `incomplete: false` establishes traversal coverage, not an atomic vault snapshot. Stop abandoned producer work with `closeProperties({cursor})`.

This generic API shares the existing bounded search engine and connected-vault safety checks. It reads frontmatter only for semantic projection, without parsing entire note bodies. Selected property data is bounded to 4,096 serialized characters per note; unsupported metadata makes coverage partial. It has no GTD classification policy: the [GTD adapter](../gtd/README.md) owns project conventions and counts. Existing agent-tool signatures are unchanged. SDK declarations and Zod are aligned with BB SDK 0.6.132 for these consumer calls.

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

- iCloud owns Apple setup, mirror storage and native sync. Obsidian uses
  schema-validated, host-caller-checked iCloud RPCs; local filesystem roots never
  enter Obsidian settings or tool results. iCloud must advertise matching note access v2.
  There is no uncoordinated filesystem fallback.
- Initialized sound local sources can be read and saved while native sync runs,
  cloud sync is paused, or Apple is disconnected. iCloud owns local availability;
  cloud phase, connection and last-success timestamp report sync state,
  not local authorization or a judgment that notes are stale. The timestamp is
  recorded after the host sync operation returns successfully; it does not prove
  every note reached iCloud or another device. Null means no successful sync
  recorded (never synced or history unknown). Report times in the user's timezone,
  without an elapsed-age freshness warning. Genuine local safety blockers refuse operations.
  Retained/rebuilt mirrors require new IDs and explicit connections.
- Reads and saves share iCloud's actual native worker generation and inherited
  operating-system flock. Logical publications may occur during the owner's own
  native child, while mirror mutations wait for a native-idle turn. Disposal
  stops admission and waits before releasing ownership.
  This does not promise a vault-wide snapshot or an OS transaction against
  unrelated trusted writers with the same filesystem access.
- An edit requires a prior complete whole-note read in the same BB thread and its
  SHA-256 hash. Section, metadata and incomplete paged reads are insufficient. iCloud rechecks source admission,
  parent/file identity and expected bytes under its worker owner. A conflict writes
  nothing from the stale patch; reread and prepare a fresh change.
- iCloud durably publishes an immutable per-note logical generation and receipt
  outside the mirror before acknowledging the save. Bounded native-idle application
  later copies bytes to the mirror under the owner. Creates cannot overwrite and
  conditional replacements cannot bypass expected-byte checks. No whole-folder
  backup or separate cloud sync engine is used.
- UUIDv7 operation identities are persisted before submission. Durable journals
  and immutable receipts deduplicate operation IDs; crash recovery does not infer
  success from matching text or timestamps alone. Uncertain operations block another edit
  to that note until inspected. Cancellation before submission saves nothing;
  after submission, the atomic operation may complete and must be inspected.
- A confirmed result means **saved locally, pending iCloud sync**. A later sync
  timestamp does not verify those bytes in iCloud or on a phone. Never repeat an
  edit just because its later sync failed. Use `obsidian_status` to inspect a lost
  reply by its persisted exact ID, vault and path, independently of the recent page.
- Remove invalidates content proofs/cursors and revokes content/receipt exposure.
  The producer must accept the revoking revision before removal is confirmed. A
  lost configuration reply stays unconfirmed and must be checked again. A local
  save accepted before revocation is not undone. Removal does not delete notes, pause sync or disconnect Apple.

## Immediate-child consumer

Sources implementing `VaultFiles.children` advertise `childrenAccessVersion: 1` in status. `listChildren({vaultId, folder})` returns bounded immediate `{name, kind: 'directory' | 'markdown'}` entries and `incomplete`; no note bytes, paths outside the connected source, edit proofs or GTD policy. The iCloud adapter forwards to owner-checked `noteChildren` under revision-bound local-source admission. Each call is capped at 5,000 visited entries, 512 KiB of serialized entry data and two seconds. Limits, symlinks, inaccessible directories and unsupported names make coverage incomplete, never confirmed empty. There are no retained directory cursors; callers retain their own bounded inventory paging and must combine coverage with metadata reads. Existing property pages, including empty continuations, still must be drained.

Native BB disable/reload closes dispatch. Obsidian's disposal hook closes operation admission and waits for entered title/tool work before stopping service state; it does not cancel a producer save after admission. Title caller cancellation is checked before save submission. Durable source receipts remain authoritative after uncertain delivery. This is a shutdown boundary, not a new pause/settings workflow.

## GTD relationship projection

`projectAreasVersion: 1` advertises the GTD-only `projectAreas` read-only RPC. It accepts at most 50 explicit project root-note paths, the selected vault prefix and exact Areas folder. Internally it projects `areaId`/`area` metadata, or a dedicated `Area` section only when both are absent. Populated metadata must resolve consistently; section evidence is limited to eight standalone/bullet wikilinks. It returns only per-path `none`, `resolved` with canonical `areaId`, or `unresolved`, plus source incompleteness. No bodies, snippets, hashes, edit proofs or writes cross this boundary.

Local reference matching uses selected-vault-relative or mirror-prefixed paths, optional `.md`, display aliases and unique basenames; no external URL, title/topic inference or alias-property index is involved. Targets must be within the configured Areas folder. Directory targets are verified through existing bounded child reads, including nested directories, without manufactured notes. Incomplete target catalogs never establish a unique relationship. Each batch is bounded to 2 MiB of root-note bytes, ten seconds of projection work and 50 additional directory probes; omitted/failed rows are incomplete, not confirmed missing relationships. Native disposal tracks the admitted projection and underlying source operations retain their existing revision guards.

## GTD title consumer

The `renameTitle` RPC accepts `{ vaultId, path, title }` only from the host-verified `gtd` plugin caller. It changes a display-title property, not a physical path. GTD validates inventory membership before calling it. Obsidian performs a unique-reader complete read (including every continuation acknowledgement), then invokes its existing version-checked property editor. Paths, links and unrelated bytes remain intact; existing parser, connection, conflict and uncertainty guards still apply. The bounded result is `{ operationId, outcome }`, not note content or a cloud-delivery claim. Failed or uncertain writes are never retried automatically. Ordinary clients and other plugins are refused before reading a note.

Reloading this file-writing integration requires a supported maintenance boundary that prevents new writes and drains accepted operations. A reload abort signal or empty receipt list is not such a guarantee; use a disposable preview when that boundary is unavailable.

## Supported Markdown subset

The [pinned official references](docs/reference/README.md) guide behavior;
`mdast-util-from-markdown` 2.1.0 and `yaml` 2.9.1 supply maintained parsers.
No runtime `obsidian` package is used and full Obsidian search/resolver parity is
not claimed.

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
| Task/link directory discovery | 10,000 entries or 2 seconds; nested/hidden folders included; incomplete results are explicit |
| Task/link scan (not search) | 500 notes, 16 MiB plus at most the final 1 MiB note, or 3 seconds checked between file operations; at most 500 rows |
| Output | At most 48,000 UTF-16 units per read chunk, reduced to fit a 60,000-character serialized read envelope (including JSON escaping); final tool result capped at 64,000 characters; metadata collections capped at 100 items |
| Whole-note read continuation | Four in-memory sequences including in-flight continuation reservations (all busy refuses new sequences), five-minute idle / thirty-minute absolute lifetime; single-use thread/target/selector-bound cursors, with final empty acknowledgement; no section pagination |
| Search resources | Four sessions, two child/work reservations; up to 64 read-only note descriptors per batch, one directory stream per session, bounded discovery/dedup and subprocess buffers; no mmap or unbounded threads |
| Search continuation | Five-minute idle / thirty-minute absolute lifetime; up to 32 batches or a two-second cooperative slice before yielding, never a terminal total-note cutoff; configuration/local safety changes and restart revoke cursors, ordinary cloud progress does not |
| Search semantics | Properties inspect at most a 64 KiB header independently of the body; tags retain the 64 KiB semantic-parser bound and disclose omitted notes |
| Search result pages | Default 20, maximum 50 rows; a complete traversal can still have buffered rows behind nextCursor |
| Task/link pagination | Default 20, maximum 50 rows; ten in-memory cursors, expiring after 60 seconds or configuration/local safety changes, not cloud progress |
| Save conflict-copy inspection | At most 10,000 siblings; larger/ambiguous sets refuse with uncertainty. This separate save-safety bound is not a search cutoff |
| Complete-read proofs | 256 in-memory note versions, bound to the reading thread; issued only after bounded complete delivery without parser-limit warnings, invalidated on the affected note save, configuration change and restart |
| Pending saves | 100 persisted unresolved operations |
| Private iCloud note recovery | 64 MiB / 256 active paths globally (16 MiB / 128 paths per vault); separate bounded recovery and receipt quotas |
| Receipts / previous versions | 30-day definite replay/previous-version window; 32,768 receipt rows / 64 MiB and separate 64 MiB recovery; uncertain entries stay protected |

Capacity stops new writes **before** replacing notes. Expired timestamp-bearing
operation identities cannot commit again even after receipt pruning; identities
more than five minutes in the future are also refused. An operator must inspect
uncertain journals or capacity pressure; deleting journals to force another append
is not recovery. Receipts are bounded facts about past operations, not evidence of
current file contents. Files changed outside these tools have no new per-note backup.

### Operator-assisted restoration

1. Preserve the current note and the relevant private operation record before
   investigating. Keep these copies outside all synced mirrors and private to the
   service account; do not print their contents or paths in public diagnostics.
2. Review the receipt, expected hashes, archived previous-version bytes and current complete
   note. An uncertain outcome needs journal/inode inspection, not replay.
3. Ask which version or merge should be restored. Preserve newer changes separately.
   Prepare the desired content against a fresh complete read and its current hash.
4. For an active conflict, inspect the exact path/token and guarded incoming
   content or absence with `obsidian_status` / `obsidian_read_note`. Choose keep
   local, accept incoming or an explicit replacement through `obsidian_edit_note`
   with the expected logical/incoming versions. A stale token needs fresh inspection.
   No choice silently deletes cloud files or changes an old receipt.
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
