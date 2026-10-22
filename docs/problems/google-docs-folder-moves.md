# Google Docs cannot be moved between folders

Status: open capability gap. Reported 2026-10-21.

## Problem

The assistant cannot move a Google Doc from one Google Drive folder to another. Users must leave the assistant workflow and reorganize the document manually.

## Evidence

The user reported this limitation. The Google Drive plugin currently exposes account discovery, search, folder browsing, file metadata, and Google Docs reading, but no file-move operation:

- [`plugins/google-drive/server.ts`](../../plugins/google-drive/server.ts)
- [Plugin README](../../plugins/google-drive/README.md), which describes the plugin as read-only.

This is a missing capability, not evidence of a failed move request or a Google Drive service limitation.

## Desired outcome

The assistant can move a selected Google Doc between folders in an explicitly selected account, preserving the document's identity and content. Resolve ambiguous documents or destinations before changing anything, report permission restrictions clearly, and verify the resulting folder membership. Do not silently copy the document or alter unrelated sharing settings.

No implementation or live Drive changes were made while recording this problem.
