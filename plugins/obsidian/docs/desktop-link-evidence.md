# Obsidian desktop link evidence

The BB Obsidian plugin operates on vault files. Its runtime, build and regular
tests require no Obsidian desktop installation or extracted bundle.

## Reproduce the desktop check

On Linux, use Node 22 or newer, npm, curl, gzip, tar, and sha256sum. These commands
use the official Obsidian 1.15.1 release. The helper verifies the release
archive against the pinned SHA-256 before exposing `app.js`. It puts both the
verified archive and its extraction in the user cache outside the checkout.

```sh
app_js=$(bash scripts/dev/obsidian-desktop-source.sh)
rg -o 'getFirstLinkpathDest\(|getLinkpathDest\(|runAsyncLinkUpdate\(|updateAllLinks\(|updateInternalLinks\(|function Ibe\(' "$app_js" | sort -u
```

The optional Linux x64 fixture downloads and checks the official desktop tarball,
with the app's usual system library requirements. It launches the app headless
with a disposable profile and a synthetic vault. The probe then calls the
desktop cache and performs one rename confined to that vault.

```sh
app_js=$(bash scripts/dev/obsidian-desktop-source.sh --linux-app)
desktop_dir=$(dirname "$app_js")
node scripts/dev/obsidian-desktop-fixture.mjs \
  "$desktop_dir/linux/obsidian" "$desktop_dir/obsidian-1.15.1.asar"
```

For a new baseline, update the helper's release and pinned digests from the
[official release](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.15.1).
Update the fixture's version and extracted ASAR digest and recheck the symbols,
candidate order, and resulting link text against that release.

## Observations in 1.15.1

- `MetadataCache.getFirstLinkpathDest` takes the first result of
  `getLinkpathDest`. The resolver looks up the final filename, using the literal
  extension when available and otherwise appending `.md`. It tests an exact
  vault path first, rebasing explicit dot-relative paths on the source folder.
  A leading slash requires an exact vault path. Otherwise it considers suffix
  matches, grouping source-folder-prefix matches ahead of the remaining paths.
  The comparator `aJ` sorts each group by path length. Equal lengths have no
  additional comparison in that function.
- `FileManager.renameFile` calls `runAsyncLinkUpdate`. That method waits for a
  clean cache, collects source files and ordered resolved candidates, performs
  the rename, and passes the observations to `updateAllLinks`. The helper
  `Ibe` compares the new candidate paths with the recorded ones. On a changed
  list it generates link text for the previously selected file and carries over
  the fragment. `MetadataCache.updateInternalLinks` applies those updates.
- The disposable run confirmed that `[[README]]` in a nested journal targets
  the vault-root README, the explicit project path selects the project README,
  and `[[./README]]` inside the project selects the local README. It also
  confirmed folder-prefix and shortest-path precedence, an equal-length
  candidate tie, and native rewriting of the explicit project backlink.
  The external `file://` link and the journal's bare link remained identical.
  The pre-existing link to the destination acquired a target after the rename.

BB treats equal-ranked targets as ambiguous and reports their paths rather than
relying on Obsidian's cache ordering. BB checks links that were missing before
the move too, and refuses a move that would give one of them a target. Preview
and apply recheck live coverage, names, and note versions. A ready preview is
point-in-time evidence. The write adapter revalidates at its write boundary and
the receipt reports incomplete verification if subsequent checks detect a
concurrent change. Independent editors and sync processes do not share a
vault-wide transaction with BB.
