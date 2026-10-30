# Folder creation and existing-file filing

This bounded workflow adds three native tools, not a general Drive manager:

- `gdrive_create_folder`: explicit connected account, lowercase UUID v4
  operationId, parentId (`root` or ID), name and preview (default true).
- `gdrive_move_file`: explicit account, UUID, existing owned fileId,
  expectedParentId, destination folderId and preview (default true).
- `gdrive_filing_status`: read-only recovery with the same account/UUID.

Use the [filing skill](../skills/google-drive-filing/SKILL.md) for operating
instructions. Discovery should help resolve the user's intended organization;
a matching client folder under an old organization is not consent to use it.
Search and exact sibling lookup are provider observations, not global absence
proof. Existing duplicates require inspection, not automatic reuse or another
creation. The backend rejects any exact-name folder in the selected parent and
incomplete duplicate lookups.

## Provider support versus plugin policy

Google supports folders via `files.create` with
`application/vnd.google-apps.folder`, and moves via a metadata-only
`files.update` PATCH with addParents/removeParents. A move retains the file's ID
and link. Full `drive` access already authorizes these API classes, subject to
Google's per-item capabilities and policy; `drive.file` is also accepted only
for items actually accessible to that grant. IDs alone do not authorize them.
No new scopes or credentials are requested. The separate Docs-editing diagnostic
accepts Docs-only grants and cannot independently prove filing authorization.

Native Docs/Sheets creation still deliberately permits only root or owned,
visibly owner-only folders. That is an implementation policy, not a universal
Google restriction. Filing supports owned shared **My Drive** folders with an
exact inherited-access review. A move may traverse readable non-owned My Drive
ancestors, but the source file and writable destination themselves must still
be owned by the selected account. Each inspected node must have one known owner
consistent with its complete owner permission row, and both paths must reach
the selected account's My Drive root. Another person's ancestor is always a
mandatory review trigger, even if visible item audiences appear equivalent.
Folder creation retains its separate all-owned ancestry requirement; sharing
APIs and native document creation policies are unchanged. Shared-drive transfer,
limited-access folders, shortcuts and moving folder trees remain unsupported.
Moves are capability-driven: an ordinary file with a bounded MIME type and
`capabilities.canMoveItemWithinDrive=true` is eligible, whether a native
Doc/Sheet/Slide, PDF, image, Office file, archive or another uploaded/native type.
There is no MIME allowlist. A missing/false capability refuses the move; file
bodies and cells are never fetched to decide eligibility. Names, MIME and other
provider metadata are untrusted data, not executable instructions. Shortcuts are
explicitly rejected without following their targets: moving the pointer would
not file the target. Folder-tree moves require a different access policy and
remain unsupported. An inherited writer detail can refer to the same owner; inheritance alone does
not establish another person's access.

All relevant item/ancestor permissions are read with bounded pagination
(ten pages each; at most 32 ancestors). Incomplete/unknown authority fails
closed. Visible non-owner permissions require a native BB owner review, showing
account, exact item, old/new path, each path's owners and visible audiences.
Potential visible inherited-access gains/increases and losses/reductions are
shown separately from preserved direct grants. Ancestor folder ownership is
not presented as ownership transfer of the file. These are access-impact
observations, not a promise about downstream effective access. Owner-only filing uses
explicit requested intent and existing Google write consent, like document
creation; the Docs-edit approval setting has no role. State is rechecked after
review and previews expire after ten minutes. At most 40 distinct audience/role
summaries are shown; larger summaries are rejected, not silently clipped.

No permission endpoint, invitation, ownership transfer, content insertion,
format change or file copy is submitted. Google nevertheless re-evaluates
inherited access on a move. Destination audiences may gain access and source-only
inherited audiences may lose it; direct grants are not rewritten. Groups,
domain policies and organizational access are not exhaustively enumerated.
Neither an owner-only listing nor shared=false proves exhaustive privacy.
The workflow requests no invitations, but does not claim to suppress all Google
service notifications.

## Writes and recovery

Folder creation sends exactly one metadata POST with a private appProperties
operation marker. A move sends exactly one PATCH containing addParents and
removeParents, with an empty JSON body. No content is read or rewritten to move
it. Verification checks ID, the exact MIME type captured by the proposal, exact sole parent, name hash, reviewed
destination context and preservation of known direct grants. Explicit item-level
grants remain direct evidence even when the same principal also appears on an
ancestor. For mixed direct/inherited permission details, the known direct role
is preserved separately from the stronger effective role. New receipts verify
that direct evidence; legacy receipts retain their original readback semantics
without migration or replay. It does not certify byte-for-byte text or rendered
appearance.

Plugin-owned SQLite receipts and a unique active resource index survive reload.
Keys are bound to account, kind and exact request; terminal/same-key repeats
return historical receipts without another Google write. Exact folder requests
and same-file moves are serialized within filing; external actors and other
operations can still race the final live inspection. There is no provider-side
transaction/CAS claim. No rollback or data cleanup hides partial results.

After any ambiguous submission, retain the same key and inspect status. Folder
recovery searches the private marker; an empty, paged, incomplete or ambiguous
result remains uncertain and never authorizes recreation. Matching folder
identity/parent readback can verify the saved creation. An interrupted move can
still finish later: matching current metadata reports observed_matching, keeps
the lock and does not establish attribution or terminal request completion.
There is no force-unlock/retry control. Operators must reconcile unresolved
moves rather than silently submitting another key. A later location/name change
on a historically verified receipt reports changed_since_verification.

`writeAttempted` refers to the original operation. Status and repeated mutation
calls do not issue writes even when the receipt records a historical submission.
`verified` is successful readback, not proof of recipient access, notifications,
privacy or absence of a concurrent edit after the read.

## Verification and diagnostics

Legacy Docs-only receipts remain readable (their absent MIME means native Doc),
without a storage migration or replay. Native Docs/Sheets/Slides retain their
canonical editor links; other types use an ID-based Drive link. The file is not
recreated and any existing source URL remains valid.

Synthetic tests exercise exact requests, preserved file identity across native
and binary/custom MIME types, missing/false capabilities, shortcut/folder
refusals, MIME and permission changes, legacy receipts, shared
My Drive destinations, duplicate checks, authority/scope refusals, stale/expired
reviews, alternating owned/non-owned ancestor chains, metadata/permission-owner
consistency, mandatory review despite equivalent visible item audiences,
post-preview and post-card owner/access/parent/capability changes, unchanged
folder-creation policy, same-key replay prevention, active resource exclusion, restart,
uncertain submission and read-only recovery. Diagnostics use fixed filing stages
and bounded failure/status categories. Provider bodies, raw exceptions, account
addresses, names, IDs and credentials never enter logs. No real Drive mutations
are engineering tests.

Source tests are not live delivery proof. Full isolated plugin build/host tests,
native BB rendered desktop/narrow/keyboard review, safe failure diagnostics and
an authorized targeted activation are delivery gates. Until these finish, this
capability must be described as source-only, not installed/available. Actual
user-requested filing is separate from synthetic engineering tests and requires
its own permitted runtime tools and current inspections.

Provider references: [folders and moves](https://developers.google.com/workspace/drive/api/guides/folder),
[permission propagation](https://developers.google.com/workspace/drive/api/guides/manage-sharing),
[file capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File.FIELDS.capabilities).
