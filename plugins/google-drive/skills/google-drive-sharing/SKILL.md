---
name: google-drive-sharing
description: Grant, change or revoke a direct Google Drive file or folder permission, including anyone-with-link access, with mandatory owner approval and read-only recovery.
---

# Safe Drive sharing

Use only for a user-requested access change, never as a delivery test.

1. Resolve the exact file/folder ID and explicit connected account. Read `gdrive_inspect_sharing`; check listingComplete and listingError. This shows Google-visible permissions, not everyone with access or a privacy guarantee.
2. Generate one lowercase UUID operationId. Call `gdrive_change_sharing` with preview omitted/true. Preview inspects live authority, full bounded permissions and ancestry plus the existing write scope. It does not broaden OAuth or invite anyone.
3. Review the exact target, audience, current/proposed role, notification behavior and folder impact. Grant accepts audience `{type:"user"|"group",emailAddress:"..."}` or `{type:"anyone"}` and role reader/commenter/writer (anyone: reader/writer only). Change/revoke require the exact permissionId from inspection; revoke has no role. Existing owners are never changed. To change an existing recipient, do not grant again.
4. Apply using the SAME operationId and arguments with preview=false. BB requires owner approval; Settings cannot bypass it. Previews expire after ten minutes. After approval, live state and write scope are rechecked. Stale previews do not write; make a fresh proposal only after inspecting a known no-write outcome.
5. Only outcome verified confirms exact permission readback and preservation of other Google-visible permissions. It does not prove a recipient can open the item, that invitations arrived, or exhaustive privacy.

## Exposure and limits

- Anyone means **anyone with the link**, allowFileDiscovery=false, not publicly searchable/discoverable. Links can be forwarded. Changing an existing discoverable public permission explicitly reduces it to link-only. Removing it does not remove named, group, domain or inherited access, or existing copies.
- Folder permissions can affect contained and future inheriting items. Descendants/full audiences are not enumerated. No recursive edits to descendants or ancestors are performed.
- Only owned My Drive items with inspectable, owned ancestry are supported. Shared drives, limited-access ancestry, inherited target permissions, missing authority, incomplete listings and ambiguous/unsupported policy state fail closed. Missing permissionDetails alone never proves direct access: ancestry is inspected. Existing domain permissions are preserved but not editable here. No ownership transfer.
- Named grants default to notify=false (sendNotificationEmail=false). notify=true explicitly opts into Google’s sharing email; ask only when the user requested an invitation. Public grants cannot send invitations. Google exposes no notification control for update/delete; the tool requests none but cannot suppress all Google service notifications. Do not promise silence beyond that.
- No Google permission revision/CAS precondition is exposed here. Post-approval inspection reduces stale writes but cannot eliminate external read/write races; readback detects mismatches. There is no hidden rollback.

## Recovery

After lost replies, interruption, partial outcomes or verification failure, call `gdrive_sharing_status` with the SAME account and operationId. Repeated mutation calls return saved receipts, not another write. Status only reads provider state; it never retries or rolls back.

Uncertain writes retain an item-wide lock across accounts and restarts. A matching exact readback can resolve the receipt. An absent/unchanged permission cannot prove an interrupted request will never complete; an unresolved operation remains blocked. If the target, permission ID or other permissions diverged, inspect in Google Drive and seek operator review—do not invent a new key to bypass the lock. A verified receipt is historical until status reads again. A recovered matching state is observed evidence, not proof which actor made it or that an email was sent.
