# An overwrite briefly removes the note from other devices

Status: open. A stock rclone limitation; no workaround in BB.

## Problem

Stock rclone's iCloud Drive backend can't change a file's contents in place. To overwrite a file, it moves the existing document to iCloud's Recently Deleted and uploads a new document with the same name. The direct push and the bisync scan both use this overwrite.

Each edit made through BB therefore reaches other devices as a deletion followed by a creation. For a few seconds, the note doesn't exist there. If it's open in Obsidian on that device, Obsidian may treat it as deleted and close or blank the tab. An edit made on that device during the gap can come back as a sync conflict, which the [conflict sweeper](../../../obsidian/README.md) then merges.

## Current evidence

Measured on 2026-11-28 with three BB edits to a throwaway note, watched from a Mac:

| Edit | Save → on the Mac | Note missing on the Mac |
|---|---|---|
| 1 | 7.7 s | 2.5 s |
| 2 | 8.5 s | 2.9 s |
| 3 | 7.7 s | 2.5 s |

- The iCloud document ID changed on every push. A listing showed a different `FILE::com.apple.CloudDocs::…` ID after each overwrite.
- The author of rclone's iCloud backend describes this behaviour: iCloud appears not to support replacing a file, so rclone trashes it and uploads a new one ([rclone PR #7717](https://github.com/rclone/rclone/pull/7717)).
- The retired patched worker updated notes in place, keeping the document and its ETag, and reached the Mac in 7.9 s with no gap. Its approach is in git history under `plugins/icloud/native/managed-worker.patch` (`bb_note_replace.go`), removed in `b782bae`. That's evidence that Apple's web API can update in place.

Not yet observed: what Obsidian on the Mac actually does with an open note during the gap.

## Desired outcome

An edit reaches other devices as a change to the same document, with no period when the note is missing. Fix this upstream in rclone rather than by carrying a patch:

- **Best:** an in-place update in the iCloud backend.
- **Smaller:** uploading the new document before trashing the old one, which would at least shorten the gap.
