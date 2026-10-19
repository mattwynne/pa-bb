# Obsidian search cannot cover the whole vault

Status: open in the deployed 0.2.0 plugins. The 0.3.0 correction has passed
generated-data, installed-BB and rendered checks; production delivery and owner
feedback remain. See [iteration 016](../plans/016-ripgrep-vault-search.md) for
current implementation and delivery evidence.

## Problem

Asking BB how many project notes have a particular status produces an incomplete
count. The deployed search examines only a bounded alphabetical prefix of the
vault. Pagination returns more matches from that same prefix, not matches from
notes it has not visited. Asking to search the rest cannot complete the search.

Results from a hidden subfolder also exposed an ambiguity about scope. Hidden
folders belong to the connected vault; their names do not establish that they
are an archive or an old snapshot. Silently excluding them would hide the
coverage defect rather than fix it.

This concerns our BB Obsidian plugin, not Obsidian's built-in search or a choice
of iCloud snapshot. A literal search for `status: active` is also not a reliable
query for a YAML property or a definition of which notes represent projects.

## Evidence

The owner reported incomplete counts and matches from a hidden subfolder after
connecting a vault. Inspection of the 0.2.0 implementation established:

- Directory discovery stops at 10,000 entries or two seconds.
- A scan stops at 500 notes, 16 MiB or three seconds, reading through iCloud one
  note at a time.
- Result pages contain only rows collected by that scan; they cannot advance
  into unvisited notes.
- Search supports literal text and tags, but no typed property or folder filter.

These are independent limits. The exact limit reached by the reported call was
not correlated with a trace. Existing tests proved bounded work and explicit
incompleteness, not complete searches across an ordinary large vault.

## Desired outcome

- Search the complete requested vault or folder scope, including hidden and
  nested notes unless explicitly excluded.
- Continue through unvisited notes across response pages, including pages with
  no matches. BB should follow continuations without repeated prompting.
- Support exact typed YAML property filters and explicit folder scopes. Do not
  infer project identity or archive status from folder names.
- Return a total only after complete coverage and filtering. Partial results,
  unreadable notes and expired searches must not become confident counts.
- Search the current local note view, including saved edits not yet copied into
  the native mirror, without waiting for background sync.

Count matching notes, not lines or inferred real-world projects. Copies at
separate paths remain separate notes unless the query excludes them. A complete
traversal is not an atomic snapshot of a vault changing during the search.

## Boundaries and resolution

Preserve whole-vault connection consent, safe file access, conditional saves and
private diagnostics. Do not add a persistent index, note browser, folder
permissions or automatic vault connections. Task listing and link resolution
have separate scan limits; fixing search does not make those tools complete.

Iteration 016 uses ripgrep and genuine continuation to address this problem.
Generated checks and an actual installed-BB handler test cover searches beyond
the old cutoffs; they do not establish production delivery or responsiveness in
personal use. The owner will assess responsiveness, without a performance
release gate. Personal-note queries or writes require separate authorization.

Delete this brief once the correction is delivered and the problem is resolved;
retain implementation and verification history in the iteration plan.
