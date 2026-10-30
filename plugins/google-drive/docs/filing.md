# Requested Drive filing

Filing preserves existing file IDs and URLs. It never copies files, edits content,
changes permissions, transfers ownership or sends invitations. Google may still
send its own service notifications. Use only for user-requested filing, never
real provider writes as engineering tests.

## Tools and task review

- `gdrive_create_folder`: explicit account, single-use lowercase UUID v4
  `operationId`, `parentId` (`root` or ID), `name`, `preview` (default true).
- `gdrive_move_file`: account, UUID, `fileId`, `expectedParentId`, `folderId`, preview.
- `gdrive_filing_task`: account, task UUID, preview, and 1–20 exact `items`.
  Each item has `kind: "move"` or `kind: "folder"` and the corresponding tool's
  arguments except account/preview. Each item needs its own distinct UUID.
- `gdrive_filing_status`: account and the same task or individual UUID. Recovery
  never submits a provider write.

Preview first; apply with **identical arguments and keys**, changing only
`preview:false`. For a requested batch, use the task tool rather than separate
per-file calls. One concise native review covers all exact items, destinations,
requested folder creations and access effects in that task. No agent can supply
approval via arguments or carry consent into another task. Existing operation
keys cannot be adopted into a new task. Task preview payloads are capped at
64 KB; larger requests must be explicitly split, not clipped.

All destinations must already exist and be inspectable at preview. A task can
include folder creation alongside moves to existing destinations, but cannot
move into a folder created within that same task. Create and verify that folder,
then inspect it before proposing a task targeting it. This is an existing-destination limitation, not an approval requirement for
empty-folder creation. Inheriting the explicitly selected destination's audience
needs no filing card. Later moves independently evaluate document exposure;
creation never authorizes that exposure or carries consent into the later task. There is no provider transaction or CAS guarantee.

Tasks are not atomic. Each item keeps an individual durable mutation receipt,
claim, pre-write revalidation and readback. Processing stops at the first
non-verified result, material change, expiry, cancellation or interruption.
Earlier items may have completed; later items may remain proposed. A partial
result includes each receipt and access impact. Failed preparation retains a task
receipt with prepared and unprepared children. An abandoned preparation/review
becomes interrupted on recovery; consent never survives a lost invocation. Never replay a task to finish
its remainder. Inspect the same task/child keys and report exactly what completed.
A separately requested continuation needs fresh inspection and any required review.

## Owner-controlled filing policy

Google Drive Settings has **Approval for filing I request**:

- **Only when access changes** (default): review meaningful visible audience or
  role/duration changes, including gains, reductions, expiration/permanence changes
  and potential source-inherited losses.
  Empty-folder creation in an explicitly user-selected destination is exempt:
  inheriting existing audience/roles (including a non-owned ancestor) discloses no
  existing document, for standalone creation and folder items in tasks. Do not
  ask again merely because the selected destination is shared.
- **Never for filing I request**: suppress filing cards for requested folder
  creation and moves. Report access effects afterward. All capability, inspection,
  claim, revalidation, verification and uncertain-write recovery checks stay on.

Only the owner changes this setting. Tool arguments cannot override it. The
existing Docs text/formatting approval setting is independent; uploads and explicit
sharing mutations keep their own policies.

Consent decisions compare structured audience identities and effective role
ranks from complete inspected lists, including preserved direct grants. They do
not compare display strings. For each effective role threshold they also compare
how long grants last, so extending expiring access to permanent access is reviewed. Shared ancestry, another person's ownership of an
ancestor, and generic caveats about group membership or organizational policy
are not independently meaningful changes. Reliably unchanged audiences/roles
with preserved direct shares execute without a card under the default policy.
Unknown or inconsistent owner/authority and incomplete listings still block;
a potential inherited loss is reviewed rather than assumed safe.

## Supported operations and evidence

Moves require an owned ordinary file, an owned writable My Drive destination,
`canMoveItemWithinDrive=true` and existing `drive`/`drive.file` consent. Native
Docs/Sheets/Slides, PDFs, Office and other bounded ordinary MIME types are
capability-driven, not allowlisted. Bodies/cells are never read for filing.
Shared drives, trash, folder trees, shortcuts and limited-access ancestry are
unsupported. A shortcut would move its pointer, not its target.

Folder creation supports owned or non-owned My Drive parents with
`canAddChildren=true` and complete explicit selected-user owner/writer evidence.
The creator must own the new folder; parent ownership stays unchanged. Exact-name
duplicates and incomplete sibling lookups block, rather than selecting or creating
an alternative automatically.

Each path must reach the selected account's My Drive root. Fully readable foreign
ancestors are allowed, with consistent unique metadata/permission owners. Complete
bounded permission pagination (ten pages per item, at most 32 ancestors) and at
most 40 audience/role summaries are required. These are Google-visible facts,
not exhaustive privacy: group members, domain policies and other access routes
are not fully enumerated. A generic caveat does not itself mean inheritance is
unknown. Authority and explicit direct-grant evidence are not bypassed by review.

Inspection includes both paths, permissions, capabilities and identity/scope.
Revalidation after review must match the exact persisted fingerprint before each
write. Proposals expire ten minutes after preview. A move sends one metadata
PATCH with addParents/removeParents and an empty body. Folder creation sends one
metadata POST with a private operation marker. Readback verifies identity, MIME,
name, sole parent, destination facts, known direct grants and bounded observed
access; it does not certify actual recipient access or exhaustive privacy.
Another client can race final inspection; there is no automatic rollback.

## Durable recovery and diagnostics

SQLite single-use receipts survive reload. Same-key terminal calls return saved
receipts, never another mutation. Local resource/access claims coordinate filing,
sharing and native creation; they cannot exclude external Google clients.

After uncertainty use `gdrive_filing_status` with the **same account and key**.
Folder lookup uses its private marker, never name. Empty/ambiguous lookup does
not prove absence. Matching readback can verify a saved folder creation. For an
interrupted move, matching metadata is `observed_matching`, not verified: the
original request could still be in flight. Its unresolved lock remains held.
Never retry, replace a key, force-unlock, roll back or clean up to hide uncertainty.
A later divergence from historical success is `changed_since_verification`.
`writeAttempted` refers to the original operation, not a write by status.
Legacy Docs-only receipts remain readable without migration or replay.

Tests use synthetic providers, temporary real SQLite and native no-op review
cards. Test meaningful/unchanged access, task scope, policy separation, cancellation,
expiry, revalidation, claims, partial completion, restart and no-replay recovery.
Fixed diagnostic stages and bounded categories must not expose provider bodies,
raw exceptions, account addresses, file names/IDs or credentials. Build/tests are
not applied-code evidence: targeted local-path reload and native rendered
wide/narrow/keyboard review remain separate delivery gates.

See the [filing skill](../skills/google-drive-filing/SKILL.md) and provider
[folders/moves](https://developers.google.com/workspace/drive/api/guides/folder),
[permissions](https://developers.google.com/workspace/drive/api/guides/manage-sharing),
[capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File.FIELDS.capabilities).
