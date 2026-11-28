# A direct push takes 7–8 seconds

Status: open, low priority. Delivery works; it could be a little faster.

## Problem

From a save in BB to a change on another device takes about 8 seconds. Almost all of it is BB's direct push to iCloud. iCloud then reaches a Mac in under a second.

## Current evidence

Measured on 2026-11-28 ([how the push works](../../README.md#sending-changes)):

| Stage | Time |
|---|---|
| Save in BB → iCloud accepts the push | 7.3–7.9 s |
| iCloud → change visible on a Mac | 0.1–0.6 s |

[`adapters/direct-push.ts`](../../adapters/direct-push.ts) makes several round trips to iCloud for one note save. Each one costs time:

1. `operations/stat` on the cloud copy, to check it still matches what BB last saw.
2. A read of the scan's cloud listing, which is local and fast.
3. `operations/copyfile`. In stock rclone this is itself several calls, because it trashes the old document and uploads a new one; see [overwrite-replaces-document.md](overwrite-replaces-document.md).
4. `operations/stat` again, to remember the version BB just pushed.

The individual steps haven't been timed.

## Desired outcome

Time each step first. The likely saving is the final `stat`: the version could be recorded from the local file's size and modification time instead, since iCloud keeps the modification time to the second. Expect a second or two at most. The rest is iCloud's own upload time.
