# Obsidian cannot find recently edited notes

Status: open capability gap. Reported 2026-10-25.

## Problem

The assistant cannot find notes by modification time. When a user remembers when they wrote something but not its title or wording, text search is insufficient and they must leave the assistant workflow to locate the note manually.

## Evidence

The user asked for notes about their plan for the week, probably in their inbox. The assistant checked the inbox note and searched the vault for “week”, but did not identify the requested notes. The user then asked to search by mtime because the notes should have been edited a few hours earlier.

The current [`obsidian_search_notes` contract](../../plugins/obsidian/contract.ts) supports literal text, tags, YAML properties and folder scopes, but no modification-time filter or newest-first ordering. Search results and the note-metadata tool do not expose a note modification timestamp. The assistant could not perform the requested time-based search and suggested sorting Obsidian's file explorer manually instead.

This is a missing retrieval capability, not evidence that the notes are absent, that sync failed, or that Obsidian itself lacks modification timestamps. It is separate from the [whole-vault search coverage problem](obsidian-search.md).

## Desired outcome

- Find notes edited within a specified time window, without requiring remembered text or a title, across a connected vault or an explicit folder scope.
- Support newest-first results with a displayed modification timestamp and note path so the assistant can inspect likely candidates.
- Interpret relative windows such as “a few hours ago” using the current time and the user's timezone; make the window used explicit.
- Define which modification time is exposed. Distinguish a meaningful note-edit timestamp from local mirror writes, downloads or sync-operation completion; do not present sync activity as evidence of a user edit. Report unavailable or uncertain timestamp provenance honestly.
- Account for locally saved edits as well as mirrored notes, without bypassing the coordinated local note view.
- Preserve genuine continuation, explicit coverage and failure reporting. Paginated newest-first results must not imply vault-wide ordering after scanning only a prefix.

## Boundaries

Preserve whole-vault connection consent, safe file access and complete-read/CAS requirements for edits. Finding a note by time does not authorize changing it. Do not substitute a raw filesystem fallback that bypasses logical notes or conflict handling.

No implementation or note changes were made while recording this problem.
