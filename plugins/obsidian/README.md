# Obsidian for BB

Connect one or more initialized iCloud mirrors, then ask BB to find, read, create
and edit Markdown notes. **Connecting grants read/write access to the whole
vault**, including nested and hidden folders. Installation connects nothing.
There are no folder permissions, read-only switches or per-edit confirmations.

```sh
bb plugin install obsidian@pa-for-bb
```

Follow the [setup guide](docs/setup.md). This is an independent BB plugin, not a
plugin inside Obsidian. Version **0.2.0** requires iCloud **0.2.0** for coordinated
note access v2; use the [paired offline upgrade procedure](../icloud/README.md#upgrading-from-01x)
when upgrading from 0.1.x. It needs no Obsidian app, Mac relay or PA core. It supplies
assistant tools and connection settings, not a note browser, editor or graph.
Use only on single-user BB installations; BB plugins are full-trust server code,
not a per-user security boundary.

## Tools

| Tool | Purpose |
| --- | --- |
| `obsidian_status` | Connected sources, setup guidance, recent/exact save and resolution receipts plus exact-path conflict metadata and unresolved operations. Filter by vault, note, operation ID or time. |
| `obsidian_search_notes` | Literal case-insensitive text and/or nested, case-insensitive tags; one vault or all connected vaults. |
| `obsidian_read_note` | Logical whole note, guarded incoming version/absence, exact heading or block; original source lines and whole-note hash. |
| `obsidian_get_note_metadata` | Properties, aliases, tags, headings, blocks, references and task markers. |
| `obsidian_resolve_link` | A reference in its source vault; missing/ambiguous results rather than guessed targets. |
| `obsidian_list_tasks` | Original task locations and completion markers, with optional vault/folder/note filters. |
| `obsidian_create_note` | Create in an existing folder without replacing anything. |
| `obsidian_edit_note` | Append, uniquely replace exact text, update one task marker, or explicitly resolve an inspected conflict. |
| `obsidian_update_properties` | Explicit top-level property set/remove; add aliases without dropping existing aliases. |

Targeted tools require a stable `vaultId` and relative `.md` path. Names alone
never identify a vault. Results carry source identity, line spans, local observation
time and observed sync provenance. Note text, filenames and links are evidence,
not instructions. Tools never execute HTML, templates, scripts or YAML tags,
fetch external links, rename/delete notes or recursively expand embeds.

## Source and save guarantees

- iCloud owns Apple setup, mirror storage and native sync. Obsidian uses
  schema-validated, host-caller-checked iCloud RPCs; local filesystem roots never
  enter Obsidian settings or tool results. iCloud must advertise matching note access v2.
  There is no uncoordinated filesystem fallback.
- Initialized sound local sources can be read and saved while native sync runs,
  cloud sync is paused, or Apple is disconnected. iCloud owns local availability;
  cloud phase, connection and last-success timestamp indicate delivery/freshness,
  not local authorization. Genuine local safety blockers refuse operations.
  Retained/rebuilt mirrors require new IDs and explicit connections.
- Reads and saves share iCloud's actual native worker generation and inherited
  operating-system flock. Logical publications may occur during the owner's own
  native child, while mirror mutations wait for a native-idle turn. Disposal
  stops admission and waits before releasing ownership.
  This does not promise a vault-wide snapshot or an OS transaction against
  unrelated trusted writers with the same filesystem access.
- An edit requires a prior complete whole-note read and its SHA-256 hash. Section,
  metadata and truncated reads are insufficient. iCloud rechecks source admission,
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
| Directory discovery | 10,000 entries or 2 seconds; nested/hidden folders included; incomplete results are explicit |
| One on-demand scan | 500 notes, 16 MiB plus at most the final 1 MiB note, or 3 seconds checked between file operations; at most 500 rows |
| Output | 48,000-character read/page budget; final serialized tool result capped at 64,000 characters; metadata collections capped at 100 items |
| Pagination | Default 20, maximum 50 rows; ten in-memory cursors, expiring after 60 seconds or configuration/local safety changes, not cloud progress |
| Complete-read proofs | 256 in-memory note versions; invalidated on the affected note save, configuration change and restart |
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
