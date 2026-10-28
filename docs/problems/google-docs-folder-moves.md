# Google Docs cannot be moved between folders

Status: open capability gap. Reported 2026-10-21.

## Problem

The assistant cannot move a Google Doc from one Google Drive folder to another. Users must leave the assistant workflow and reorganize the document manually.

## Evidence

The user reported this limitation. The Google Drive plugin now supports file copying, full Drive consent and safe same-account reconnection, but still has no file-move operation:

- [`plugins/google-drive/server.ts`](../../plugins/google-drive/server.ts)
- [Plugin README](../../plugins/google-drive/README.md).

This is a missing capability, not evidence of a failed move request or a Google Drive service limitation.

## Desired outcome

The assistant can move a selected Google Doc between folders in an explicitly selected account, preserving the document's identity and content. Resolve ambiguous documents or destinations before changing anything, report permission restrictions clearly, and verify the resulting folder membership. Do not silently copy the document or alter unrelated sharing settings.

Copying is not a resolution: it creates another file rather than preserving the original identity in a new folder. This move gap remains open. See [copy and destination sharing](google-drive-copy-and-sharing.md) for related progress.
