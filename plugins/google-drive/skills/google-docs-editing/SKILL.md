---
name: google-docs-editing
description: Preview or apply a revision-guarded Google Docs replacement under the owner's global per-edit approval setting.
---

Use only explicit user-requested edits, connected account emails and Google Docs
URLs/IDs. Do not use `gdocs_read`'s potentially incomplete text as edit proof.

1. Call `gdocs_inspect_for_edit({account, document})`. Require `complete: true`;
   keep the exact `revisionId`, tab ID and existing text.
2. Call `gdocs_replace_text({account, document, tabId, expectedRevisionId,
   oldText, newText, preview: true})`. Preview is the default and is not a write
   or evidence of write authorization.
3. With the same proposal, `preview: false` applies the requested edit under the
   current global policy. By default it requests the BB owner's exact-change
   approval. The owner can disable per-edit cards for all documents/accounts in
   Google Drive Settings → Configuration → Require approval for Google Docs edits.
   Do not change that setting yourself. Tool arguments cannot override it.
   Missing/unreadable policy fails closed. Disabling it does not approve a card
   already open; re-enabling it can stop a preparing no-card write.
4. Only `outcome: "verified"` confirms exact text readback at the returned
   revision. `approval: "disabled_in_settings"` is standing consent, not evidence
   of a saved change. Preview never writes in either mode. After `uncertain` or `verification_unavailable`, inspect and
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
live write authorization or native-tool detachment. To test the actual native
tool lifecycle, call `gdocs_review_edit_example({})`, end the originating turn on
BB's waiting notice, and have the owner confirm the card in that same thread in
ordinary BB chat (including the actual mobile client if relevant). Its later
result must have `exampleOnly: true` and `writeAttempted: false`.

A `cancelled` result with `reason: "timeout"` is expiry, not an owner rejection;
it does not prove the card was shown. `declined` / `owner_declined` requires an
explicit false choice. Other host cancellation reasons and `approval_unavailable`
are distinct and never authorize a write. Do not automatically replay a review.
The interactions list contains pending requests only; use the saved interaction
ID with `bb thread interactions show INTERACTION_ID THREAD_ID --json` to inspect
its terminal status/reason, avoiding document payloads in diagnostic output.

Full tool inputs, concurrency semantics and recovery: [editing guide](../../docs/editing.md).
