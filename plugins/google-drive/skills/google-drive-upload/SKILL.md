---
name: google-drive-upload
description: Upload one explicitly requested local BB-server file to Google Drive, or intentionally import a conservative XLSX as native Google Sheets, with exact owner review and read-only recovery.
---

# Upload a selected local file

Use `gdrive_upload_file`, then `gdrive_upload_status` after uncertainty. See [the complete upload contract](../../docs/upload.md).

- Only the exact user-requested file; do not scan files or credentials. The first version supports **Linux BB-server thread-storage files only**, selected by `source: {host:"bb-server", threadId, path}`. `path` is relative to that thread's public SDK-resolved storage root, not the checkout, browser, laptop or another host. No arbitrary host/URL/directory or attachment lookup. Files elsewhere need a separate supported owner-directed transfer first.
- Choose explicit connected `account`, destination `folderId` (`root` supported), output `name`, ordinary source `mimeType`, exact `expectedSha256` and fresh lowercase UUID v4 `operationId`. Source must be a regular, single-link, nonhidden file, 1 byte–4 MiB. No symlinks, devices, credentials or automatic extraction.
- Default `mode:"binary"` preserves bytes and source MIME. **Never substitute conversion**. Only an explicit user request authorizes `mode:"xlsx_to_sheet"`, source MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. This imports supported tabs/formulas through Google, not static literal cell recreation. Conservative XLSX restrictions apply; macros, external relationships/connections and unsupported formula constructs fail closed.
- Preview first (`preview:true`, default), then apply **identical** arguments/key with `preview:false`. Mandatory owner review shows local path/name/size/SHA-256/MIME/mode plus destination/owners/visible audience. File contents are not fully rendered. No setting disables this approval; the agent must not approve it.
- No sharing, invitation, overwrite, edits to existing files or grant changes. Missing write access is an owner Settings issue. Same-name files block creation, not permission to replace them.
- Only `verified` confirms acknowledged provider completion and bounded readback. Binary checks size/provider MD5 (and SHA-256 when supplied) against captured bytes. Native import verifies type/name/destination/access and tab names, samples up to 1,000 cells for formulas/errors, and always reports `fidelityVerified:false`. Do not call it a verified working model, promise recalculation, or conflate it with the source Excel workbook. Use `gsheets_read` for subsequent bounded user-requested investigation.
- Keep the original account/key after interruption. `gdrive_upload_status` only reads. `observed_matching` is NOT acknowledged completion; its lock remains. Never replay, create another key to bypass uncertainty, repair, rollback or delete automatically. A missing lookup does not prove absence.
- Engineering tests use synthetic files/fake transport only, not business uploads.
