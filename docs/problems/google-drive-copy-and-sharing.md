# Drive template copying and destination sharing

## Problem

The assistant could discover templates and folders but could not copy a selected file into an explicitly selected destination. Once copying was delivered, it also lacked a supported way to inspect destination sharing before creating potentially sensitive content there.

## Resolved capabilities

- Commit `d7df126` added `gdrive_copy_file`, preserving the source, checking copy/add-child capabilities and verifying the returned file ID and parent. Uncertain writes are never automatically replayed. Results include a new file ID and clickable URL.
- The owner approved full Drive consent instead of a Picker-based per-file flow. Existing read-only grants are not automatically upgraded. Same-account **Reconnect** retains the saved connection on cancellation/failure and rejects changed-account or stale callbacks.
- That commit was pushed and activated through a targeted native Git update, without switching installation sources. Connected desktop/narrow layouts and keyboard focus were reviewed. Synthetic failure/cancellation tests passed; live consent/failure screens were not reviewed by the implementation agent.
- The owner subsequently reported reconnecting; a read-only scope diagnostic confirmed a write grant. That diagnostic did not establish access to any particular document or prove a successful copy.

## Sharing inspection

`gdrive_inspect_sharing` now implements read-only metadata and paginated permission inspection. It reports provider-visible owners, user/group/domain/anyone permissions, discovery flags and provider-supplied inheritance details. Partial listing and visibility limits are explicit. Tests do not perform live copies or change sharing.

Implementation is not proof of delivery or complete Google visibility. Group members, domain audiences, ancestor policies and shared-drive membership may not be fully visible; even a fully paged list cannot establish privacy. No sharing mutation tool is included.

## Still separate

- [Moving a document](google-docs-folder-moves.md) remains open: copying does not preserve identity while changing folders.
- [Email attachment bytes](google-drive-email-attachments.md) remain open: copy/sharing/editing do not implement download/export.
- No live copy is authorized merely by developing or testing these capabilities. User-requested copies must inspect existing destination contents and preserve completed copies rather than blindly duplicate them.
