# Obsidian cannot search note filenames or titles

Status: open capability gap. Reported 2026-10-25.

## Problem

The assistant's Obsidian search matches note contents, not filenames. A note whose name matches the user's request can be missed when its body does not repeat the name. Direct reads require the exact path, leaving the assistant guessing filenames and capitalization instead of discovering the note.

## Evidence

The user asked for their weekly planning note. Searching for “week” across the vault did not identify it. The user later supplied the name “This Week” and said it was in the root. Direct reads using that capitalization returned `unavailable`.

A screenshot showed the actual name, “This week”. Reading the exact path `Life/This week.md` then succeeded. Its body contains the user's planning items but not the word “week”. The successful later read does not establish the note's availability during the earlier search, or prove that capitalization was the only cause of the earlier unavailable responses.

The current [`obsidian_search_notes` contract](../../plugins/obsidian/contract.ts) offers literal content search, tags, YAML properties and folder scopes, but no filename/title query. The [search service](../../plugins/obsidian/core/search.ts) passes the text query to content search. This is a discovery gap, separate from [modification-time search](obsidian-recently-edited-notes.md) and [whole-vault search coverage](obsidian-search.md).

## Desired outcome

- Discover notes by filename or filename-derived title even when the body does not contain the query.
- Offer case-insensitive exact-name and partial-name matching, with clearly defined semantics distinguishing name matching from body search. Any support for aliases or headings should be explicit, not conflated with filenames.
- Return exact vault-relative paths with original capitalization so the assistant can read the selected note without guessing.
- Support connected-vault and explicit folder scopes, including root-level notes. Return ambiguous matches rather than silently choosing one.
- Preserve genuine continuation and honest coverage reporting; a completed content search must not be described as having searched filenames too.
- Make the content-only limitation clear in tool guidance until name discovery is supported.

## Boundaries

Use the coordinated local note view and existing connection consent and safe-access controls. Name discovery does not grant complete-read edit proof or authorize edits. Do not bypass logical notes or conflicts through raw filesystem searches, and do not diagnose missing notes or sync failures from an unsuccessful content search or guessed-path read.

No implementation or note changes were made while recording this problem.
