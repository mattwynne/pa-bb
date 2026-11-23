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

| Tool | Purpose |
| --- | --- |
| `obsidian_status` | Connected sources, setup guidance, recent/exact save and resolution receipts plus exact-path conflict metadata and unresolved operations. Filter by vault, note, operation ID or time. |
| `obsidian_search_notes` | Vault-relative path globs, literal text, semantic tags, exact scalar YAML properties, folder scopes and counts over one or all connected vaults. |
| `obsidian_read_note` | Whole note, guarded incoming version or explicit legacy absence, exact heading or block, original source lines and whole-note hash. |
| `obsidian_get_note_metadata` | Properties, aliases, tags, headings, blocks, references and task markers. |
| `obsidian_resolve_link` | A reference in its source vault; missing/ambiguous results rather than guessed targets. |
| `obsidian_list_tasks` | Original task locations and completion markers, with optional vault/folder/note filters. |
| `obsidian_create_note` | Create in an existing folder without replacing anything. |
| `obsidian_edit_note` | Append, uniquely replace exact text, update one task marker, or explicitly resolve an inspected conflict. |
| `obsidian_update_properties` | Explicit top-level property set/remove; add aliases without dropping existing aliases. |

### Bounded path move and rename

`obsidian_move_note({vaultId, path, destination, expectedHash})` requires a complete source read in the same thread. For example, move `Areas/Example.md` to `Reference/New example.md`. No type property is required. Destination folders must exist; occupied destinations, unresolved operations, conflict copies and blocked sources are refused.

Preflight requires complete vault listings before and after discovery. It reads exact note versions in batches of eight and retains only proposed repairs. Discovery stops at 10,000 notes, 128 MiB of input or 20 seconds. Directory listings have separate entry and time limits. The store’s 1 MiB UTF-8 limit per note and Markdown parser complexity limits still apply. The plan is limited to 64 repairs, 8 MiB of repaired text and 32,000 serialized metadata characters.

Supported forms are unambiguous wikilinks (including aliases/embeds and heading/block suffixes) and simple inline Markdown links/images (including percent-encoded spaces and optional quoted titles). Outgoing relative links are planned using the old source location. Unrelated missing or ambiguous links can stay as written when neither location can change their target. A sibling-folder move can also preserve an outgoing short path with a unique candidate outside the two sibling folders. A path suffix alone does not authorize a rewrite. Email autolinks and HTML examples in code are left alone. Incomplete listings, path changes during discovery, indeterminate links that the move could affect, YAML links that would need to change, reference-style Markdown links, HTML link or embed attributes, parser warnings, unsupported inline syntax and special path syntax are refused before moving. The scan observes per-note versions and checks the final path inventory. It does not provide a concurrent vault snapshot.

Pass `dryRun: true` with the same read proof to check link discovery and limits without recording a move or writing notes. A ready plan reports counts only. A move reruns discovery and the file adapter checks write-time access, conflicts and the destination.

An `unsupported_links` or `ambiguous_link` result identifies the first refusal with a reason, vault-relative path and, when available, a one-based line and column. A dry run can report up to 12 such locations. The result omits note text and link targets. Plugin logs record the stage and error category.

On a filesystem mirror, the physical move creates the destination exclusively
and verifies its inode and hash before unlinking the source. Obsidian durably
records operation metadata and syncs both parent directories. An interrupted
two-name state can leave both names present. Receipt inspection checks the
filesystem evidence without replaying either mutation.

GTD plans move a landing note and carry its same-name support tree when
present. Use the project mode, optional vault root and operation ID from the
GTD plan. Obsidian checks note and attachment links in the selected vault.
Relative links are rebased only where their original targets require it.

Folder moves require a direct local mirror on Linux and system Python 3 with
`ctypes` and libc `renameat2`. The source and destination must share a
filesystem supporting `RENAME_NOREPLACE`. The directory rename preserves the
tree, including non-Markdown files and empty subdirectories. For a paired
project, the landing note first acquires a hardlink at the destination. The
original landing name is removed after the verified folder move. An
interruption can leave both landing names and the folder at either endpoint.
`project_move_partial` reports the observed locations under `components`.
An `uncertain` outcome means the filesystem evidence is inconclusive.

Recovery starts with the original operation ID. Inspect the landing and folder
evidence and resolve any collision or duplicate in the vault before making
another move. Obsidian can recognize completion after manual reconciliation
when the original landing inode and hash and the recorded tree are verified at
their destinations. Repairs that were never entered remain unapplied. Use
their reported paths to inspect and correct links individually. A receipt check
does not resume a move or replay link writes.

Link repairs are **independent CAS saves**, not one atomic transaction. A concurrently changed note is preserved and reported as not saved. Cancellation/restart leaves unstarted repairs unapplied. Inspect `obsidian_move_status({vaultId, operationId})` after any lost reply: it checks the physical receipt and individual save receipts without replay. Outcomes include `moved_supported_links_updated`, `moved_links_partial`, `project_move_partial`, `not_moved` and `uncertain`. GTD moves also check the resulting path inventory and note hashes against the preflight and repairs. An observed concurrent change leaves verification incomplete. Receipts reflect local evidence. Inspect an unknown outcome before any further write.

Obsidian tracks up to 20 moves. Legacy recovery records stay in iCloud.

Targeted tools require a stable `vaultId` and relative `.md` path. Names alone
never identify a vault. Results carry source identity, line spans, local observation
time and observed sync provenance. Note text, filenames and links are evidence,
not instructions. Tools never execute HTML, templates, scripts or YAML tags,
fetch external links, delete notes or recursively expand embeds. Path moves use the bounded capability below.

## Search and counts

`pathGlob` matches the entire vault-relative Markdown path, case-sensitively.
For example, count notes with an exact property in `Projects` or its subfolders:

```json
{"pathGlob":"Projects/**/*.md","mode":"count","properties":[{"key":"status","equals":"active"}]}
```

`*` and `?` match within one segment; a standalone `**` matches zero or more
segments. Character classes and brace choices within a segment are supported
(e.g. `{Projects,Areas}/**/[A-Z]*.md`). Use one positive pattern, up to 256
characters. Absolute paths, dot/traversal segments, backslashes, controls,
malformed classes/braces, and regex or extglob groups are not supported.
A segment may contain at most two runs of `*`, two brace groups, and twelve
commas. Like stock Picomatch, `?` matches one UTF-16 code unit, so a character
outside the BMP such as `😀` matches `??`, not `?`. Literal characters still
match literally. Globs are filters, never filesystem paths.

Direct filesystem vaults use the local index for glob and property queries that
don't include text or tags. The index requires iCloud's identity-bound directory
grant v1, negotiated through `mirrorDirectoryCapabilities(null)` without
changing the legacy `status` reply. A valid empty capability reply or the SDK's
typed missing-method response keeps existing property queries live, with
metadata-only globs unavailable. A denied or malformed capability check does
not enable that fallback. Text and tag queries still traverse live
files with host-provisioned ripgrep; a glob can restrict their hits on direct
vaults. Legacy mirrors keep searching their logical notes (including pending
edits and creates), but do not support globs. A multi-vault glob reports
unsupported sources as omitted rather than counting them as zero.

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
partial, with no reliable total. Each indexed cursor pins a published generation
per vault when it reaches that vault. Indexed rows carry a path, hash and note
observation time but no body excerpt. Live search uses per-note observations;
neither route provides an atomic filesystem view or a common time across vaults.
Search never grants edit proof.

The [host manifest](../../provisioning/README.md) pins Linux-validated ripgrep
14.1.0. Missing or incompatible search requirements show a quiet settings warning;
indexed queries, reads, saves, sync and vault choices remain intact. There is no
fallback to the old terminal bounded scanner. Task listing and ambiguous-link
discovery retain their existing separate bounds.

### What the index can tell you

An in-memory index starts in the background after local access is confirmed.
Before scanning or watching, Obsidian checks the opened root descriptor against
the device and inode in iCloud's grant, then traverses from that descriptor. A
refused, invalid or mismatched grant never falls back to path-only access. The
first indexed query waits for initial publication; later queries can read the
last published snapshot during a refresh. Nonrecursive directory watches ask the
index to rescan changed subtrees. A full scan every five minutes reconciles missed
notifications. This is not a visibility deadline: indexed results may lag a
confirmed save, and a rename whose notifications arrive separately can appear in
separate refreshes. Use an exact read for current bytes or edit proof.

A required I/O or capacity failure does not publish a partial replacement. New
queries report the affected vault as incomplete until a successful refresh;
existing pages may continue a pinned generation only while access remains valid.
Root changes, revoked access and plugin disposal invalidate those generations.
Known unsupported files (for example, oversized or invalid UTF-8 notes) and
skipped paths affect only potentially overlapping folder/glob scopes. A fixed
glob prefix entirely inside an excluded folder is disjoint; less specific
wildcard intersections are treated conservatively. Required I/O failures
still prevent publication. Derived metadata (including headings, tags, blocks, links and tasks) is bounded
separately; a derived parse limit does not discard valid frontmatter. The index
retains no note bodies and writes nothing to disk. Operator logs report bounded
`index_refresh`, `index_access` and `index_watch` categories, not paths, note contents or raw
errors. Watch degradation leaves periodic reconciliation working.

## Consumer metadata API

`vaultLocations(null)` discovers actual Obsidian vaults inside connected sources by `.obsidian` directory markers. It returns `{vaults: [{id, root, name}], incomplete}`: `id` remains the connected-source identity, `root` is the relative vault prefix (empty for a source that is itself a vault), and `name` is a display label. Discovery runs under coordinated local-source admission with pinned no-follow directory handles, excludes symlinks, and is bounded to 2 seconds / 10,000 entries / depth 32 / 100 roots per source. Missing markers are not guessed from folder names; access failures or limits make discovery incomplete. Existing whole-source connections, note paths, receipts and writes are unchanged. Consumers such as GTD apply the selected prefix internally rather than asking the user to include it in every inventory folder.

Updated source builds advertise `propertiesAccessVersion: 1` in status. Other BB plugins can call `listProperties` with an exact connected `vaultId`, one relative `folder`, 1–8 selected top-level `fields`, and an optional returned `cursor`. It returns up to 200 compact `{path, properties}` rows, `nextCursor`, `incomplete`, `warnings`, and `observedAt`; no bodies, snippets, or edit proofs. Continue every cursor with the same vault/folder/fields, including empty pages. A terminal page with no warnings and `incomplete: false` establishes coverage for the observations used by that listing, not an atomic filesystem snapshot. Stop abandoned producer work or release a pinned generation with `closeProperties({cursor})`.

This generic API uses the pinned local index on direct vaults with identity grants. Legacy vaults and older iCloud producers keep the existing live frontmatter projection. Its v1 shape is unchanged. Selected property data is bounded to 4,096 serialized characters per note; unsupported frontmatter makes coverage partial. It has no GTD classification policy: the [GTD adapter](../gtd/README.md) owns project conventions and counts.

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
  remain on the legacy interface, where existing operations can finish or be
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
- Exact filesystem reads observe current files; indexed queries may lag. Exact-path conflict
  inspection finds native conflict copies on disk. An unambiguous pair can be
  resolved with the existing guarded choice. The resolution writes the chosen
  text to the canonical path and removes the inspected copies. An ambiguous
  set requires inspection in the vault directory. A missing canonical file
  alone does not establish incoming absence.
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

## Immediate-child consumer

Sources implementing `VaultFiles.children` advertise `childrenAccessVersion: 1` in status. `listChildren({vaultId, folder})` returns bounded immediate `{name, kind: 'directory' | 'markdown'}` entries and `incomplete`; no note bytes, paths outside the connected source, edit proofs or GTD policy. The iCloud adapter forwards to owner-checked `noteChildren` under revision-bound local-source admission. Each call is capped at 5,000 visited entries, 512 KiB of serialized entry data and two seconds. Limits, symlinks, inaccessible directories and unsupported names make coverage incomplete, never confirmed empty. There are no retained directory cursors; callers retain their own bounded inventory paging and must combine coverage with metadata reads. Existing property pages, including empty continuations, still must be drained.

Native BB disable/reload closes dispatch. Obsidian's disposal hook closes operation admission and waits for entered title/tool work before stopping service state; it does not cancel a producer save after admission. Title caller cancellation is checked before save submission. Durable source receipts remain authoritative after uncertain delivery. This is a shutdown boundary, not a new pause/settings workflow.

## GTD relationship projection

`projectAreasFrontmatterOnly: true` advertises the GTD-only `projectAreasFromFrontmatter` read-only RPC; `projectAreasDeclarationKey: 'area'` confirms the YAML input contract. Updated GTD checks both and sends `declarationKey: 'area'` on every batch. A rolled-back producer either lacks the method or rejects the extra request field before invoking its resolver. Unmarked requests and the historical `projectAreas` method remain available for older GTD builds, with unchanged response shapes and the same current backend.

Both methods accept at most 50 project landing-note paths, the selected vault prefix and the exact Areas folder. Only the top-level YAML `area` key declares a relationship; a YAML `areaId` is ignored. `area` accepts a local path/wikilink string or a flat list of up to eight strings. Every declared target must resolve to the same path. The response contains per-path `none`, `resolved` with the backend path in `areaId`, or `unresolved`, plus source incompleteness. No bodies, snippets, hashes, edit proofs or writes cross this boundary.

Local matching uses selected-vault-relative or mirror-prefixed paths, optional `.md`, display aliases and unique basenames; explicit paths can address nested Area notes and directories. No external URL, title/topic inference or alias-property index is involved. Targets must be within the configured Areas folder. For an indexed direct vault, each batch uses a single authorized generation for project properties, candidate note paths and directories. A warm batch neither opens note files nor enumerates directories. It still checks current source access and the revision-bound directory identity; a denied or unconfirmed index grant does not fall back to live access. Omitted target catalogs within the selected scope cannot establish a unique relationship. Missing indexed project rows and unreadable frontmatter mark coverage partial, while an unresolved declaration by itself does not.

Legacy sources and direct sources that do not advertise the index grant still use bounded live paths, directory probes and root-note reads, extracting only frontmatter. A live batch stays on its originally authorized route and rechecks access before returning any rows. The live scan is bounded to 2 MiB of root-note bytes, ten seconds of projection work and at most 50 child-directory listings. Isolated omissions leave a partial page; source-wide refusal or route change withholds the entire page. `projectAreasFromFrontmatter` returns an authority stamp (connection revision, route and an opaque per-source authorization epoch, not a grant). Updated GTD sends it back on later batches. An observed access loss or retired index lane changes the epoch, so restored access cannot reuse earlier assignments even on the same route and revision. Ordinary index updates do not change it. Native disposal tracks the admitted projection and underlying source operations retain their existing revision guards.

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
| Search resources | Four sessions; on the live route, two child/work reservations, up to 64 read-only note descriptors per batch and one directory stream per session, with bounded discovery/dedup and subprocess buffers |
| Local index | Two concurrent builds; 100,000 entries or 120 seconds per build checked between operations; 16 MiB estimated per generation; separate budgets of 96 MiB current, 32 MiB building and 32 MiB cursor-retained so pinned or current views cannot consume rebuild headroom; at most 4,096 verified directory watches per vault, 16,384 total; up to 1,024 distinct pending directory hints before a full scan |
| Search continuation | Five-minute idle / thirty-minute absolute lifetime; up to 32 batches or a two-second cooperative slice before yielding, never a terminal total-note cutoff; configuration/local safety changes and restart revoke cursors, ordinary cloud progress does not |
| Search semantics | Properties inspect at most a 64 KiB header independently of the body; tags retain the 64 KiB semantic-parser bound and disclose omitted notes |
| Search result pages | Default 20, maximum 50 rows; a complete traversal can still have buffered rows behind nextCursor |
| Task/link pagination | Default 20, maximum 50 rows; ten in-memory cursors, expiring after 60 seconds or configuration/local safety changes, not cloud progress |
| Save conflict-copy inspection | At most 10,000 siblings; larger/ambiguous sets refuse with uncertainty. This separate save-safety bound is not a search cutoff |
| Complete-read proofs | 256 in-memory note versions, bound to the reading thread; issued only after bounded complete delivery without parser-limit warnings, invalidated on the affected note save, configuration change and restart |
| Pending saves | 100 persisted unresolved operations |
| Filesystem operation receipts | Up to 512 records within one 256 KiB storage entry. Confirmed records are retained for 30 days and pruned on subsequent writes. Uncertain records are retained for inspection. |
| Legacy recovery | Existing iCloud recovery data and limits continue to apply to legacy operations. |

At receipt capacity, inspect the existing operations before preparing another
write. Receipts record past operations. Use a fresh read for current bytes.
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
