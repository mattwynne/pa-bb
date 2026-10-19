# A local disposable integration-test environment

Status: open capability gap; the earlier experiment is archived in Git.

## Problem

Package tests do not prove that plugins install, communicate, render or update correctly inside real BB. We need a repeatable local environment for those checks without touching a live installation, personal notes, account credentials or cloud services.

## Desired outcome

Start a disposable BB installation with the plugins under test and generated data. For iCloud/Obsidian checks, local folders should stand in for the cloud remote while the real native sync process runs. Make setup, execution and teardown straightforward and document any Linux requirements.

The environment should support plugin installation and communication, note operations during sync, rendered settings checks, and updates that preserve local work and settings. Keep model-selected tool use an explicit optional check, distinct from directly invoking registered handlers. Report failures with bounded diagnostics and preserve generated evidence when useful; never reuse production state or credentials.

## Earlier experiment

The removed `fixtures/installed-bb/` experiment is preserved at commit
[`b6f3802e1798dc660af8a62554a863e5a7e6417b`](https://github.com/mattwynne/pa-bb/tree/b6f3802e1798dc660af8a62554a863e5a7e6417b/fixtures/installed-bb).
Its [README](https://github.com/mattwynne/pa-bb/blob/b6f3802e1798dc660af8a62554a863e5a7e6417b/fixtures/installed-bb/README.md) records setup and limits.

It exercised real Linux BB 0.45.0 with generated iCloud/Obsidian packages and local rclone alias sources, including sync workloads, search, browser checks, an optional provider conversation and a managed-update rehearsal. It required manual staging and coordination, so it is reference material rather than a maintained local test environment. See [the recorded findings](../plans/015-icloud-continuous-note-access.md#execution-evidence-and-stop).

Use that work to inform a reusable replacement; its historical results do not establish compatibility with current BB versions or cloud/device delivery.
