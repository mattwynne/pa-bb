---
name: google-docs-editing
description: Preview or request an owner-approved, revision-guarded exact-text replacement in a connected Google Doc.
---

Use only explicit user-requested edits, connected account emails and Google Docs
URLs/IDs. Do not use `gdocs_read`'s potentially incomplete text as edit proof.

1. Call `gdocs_inspect_for_edit({account, document})`. Require `complete: true`;
   keep the exact `revisionId`, tab ID and existing text.
2. Call `gdocs_replace_text({account, document, tabId, expectedRevisionId,
   oldText, newText, preview: true})`. Preview is the default and is not a write
   or evidence of write authorization.
3. With the same proposal, `preview: false` requests the BB owner's exact-change
   approval; it cannot bypass it. Never call an unapproved change completed.
4. Only `outcome: "verified"` confirms exact text readback at the returned
   revision. After `uncertain` or `verification_unavailable`, inspect and
   reconcile; never replay blindly. Inspect afresh for every later replacement.

This initial capability supports one unique literal match within one text run
in a selected tab, at most 2,000 UTF-16 units per text. No newlines/controls;
empty replacement deletes the match without deleting the paragraph boundary.
Documents must be complete, bounded and contain only simple text paragraphs in
all tabs. Tables, suggestions, headers/footers, objects and mixed-run matches are
not supported. Google controls formatting inheritance; styling isn't verified.

Check scope without reading any document or exposing tokens:
`bb google-drive editing-access --account ACCOUNT_EMAIL`. It distinguishes a
missing grant from unavailable verification and reports whether installed
Settings can request write access. It does not establish document edit permission.

Existing read-only grants cannot edit. Additional scopes need supported Settings
reauthorization and explicit account-owner consent; reconnecting to a read-only
flow is insufficient. Do not broaden access or handle credentials manually.

To review the actual approval UI without touching Google, run
`bb google-drive review-edit-example --thread THREAD_ID`; optional
`--state deletion` or `--state incomplete` selects another fixed synthetic case.
Every choice is a no-op and returns `writeAttempted: false`. This does not test
live write authorization.

Full tool inputs, concurrency semantics and recovery: [editing guide](../../docs/editing.md).
