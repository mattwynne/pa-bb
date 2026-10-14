# Obsidian reference snapshots

Selected official Obsidian documentation for implementing a BB plugin that reads
and edits a synced vault without running the Obsidian app. This directory is a
reference collection, not an implemented plugin or a runtime dependency.

## Sources

| Directory | Upstream repository | Pinned revision | Files |
| --- | --- | --- | --- |
| `help/` | [Obsidian Help](https://github.com/obsidianmd/obsidian-help/tree/b95e59dab8b5d94ff06376f1437c8492f14da80d) | `b95e59dab8b5d94ff06376f1437c8492f14da80d` | 28 |
| `developer/` | [Obsidian developer docs](https://github.com/obsidianmd/obsidian-developer-docs/tree/c56c7e770ba25dd0ea392aacf4588f9425970d36) | `c56c7e770ba25dd0ea392aacf4588f9425970d36` | 32 |
| `api/` | [Obsidian API](https://github.com/obsidianmd/obsidian-api/tree/9abd9605ce081383674aae1ed111c456edde0688) | `9abd9605ce081383674aae1ed111c456edde0688` | 5 |

The 65 upstream files are unmodified and were checked byte-for-byte against the
pinned Git trees. [sources.json](sources.json) records each upstream path and its
SHA-256 checksum. To find a file's source, append `/blob/<revision>/<path>` to its
repository URL, using the values in that manifest.

The API snapshot includes its [upstream MIT notice](api/LICENSE.md). Neither the
Help nor developer-docs repository supplies a repository-level licence file at
these revisions; do not assume the API's MIT licence covers those documents.
Upstream text retains its authorship and is not covered by this README's drafting
attribution.

## Start with the file format

- [Obsidian Flavored Markdown](help/en/Editing%20and%20formatting/Obsidian%20Flavored%20Markdown.md): supported Markdown dialects and Obsidian extensions.
- [Internal links](help/en/Linking%20notes%20and%20files/Internal%20links.md): wikilinks, Markdown links, paths, headings, block identifiers and display text.
- [Aliases](help/en/Linking%20notes%20and%20files/Aliases.md) and [embeds](help/en/Linking%20notes%20and%20files/Embed%20files.md).
- [Properties](help/en/Editing%20and%20formatting/Properties.md): YAML frontmatter, property types and reserved names.
- [Tags](help/en/Editing%20and%20formatting/Tags.md): inline tags and nested tags.
- [Basic formatting](help/en/Editing%20and%20formatting/Basic%20formatting%20syntax.md): task checkboxes, footnotes, comments and highlights.
- [Advanced formatting](help/en/Editing%20and%20formatting/Advanced%20formatting%20syntax.md), [callouts](help/en/Editing%20and%20formatting/Callouts.md) and [HTML content](help/en/Editing%20and%20formatting/HTML%20content.md).

## Vault behaviour and common workflows

- [How Obsidian stores data](help/en/Files%20and%20folders/How%20Obsidian%20stores%20data.md), [configuration folders](help/en/Files%20and%20folders/Configuration%20folder.md) and [symbolic links](help/en/Files%20and%20folders/Symbolic%20links%20and%20junctions.md).
- [Settings](help/en/User%20interface/Settings.md): link formats, new-note locations, excluded files and attachment locations.
- [Daily notes](help/en/Plugins/Daily%20notes.md) and [templates](help/en/Plugins/Templates.md): user-configured date formats, folders and substitutions.
- [Search](help/en/Plugins/Search.md), [backlinks](help/en/Plugins/Backlinks.md) and [outgoing links](help/en/Plugins/Outgoing%20links.md).
- [Obsidian URI](help/en/Extending%20Obsidian/Obsidian%20URI.md): opening source notes in Obsidian.

[Canvas](help/en/Plugins/Canvas.md), its [type declarations](api/canvas.d.ts), and
[Bases syntax](help/en/Bases/Bases%20syntax.md) are included for format awareness,
not as a commitment to support those features in the first release.

## API contracts, not a headless implementation

The official [`obsidian` package metadata](api/package.json) and
[type declarations](api/obsidian.d.ts) describe APIs supplied by the running
Obsidian app. They do not supply implementations that BB can import.

Useful contracts to consult:

- [parseLinktext](developer/en/Reference/TypeScript%20API/parseLinktext.md), [resolveSubpath](developer/en/Reference/TypeScript%20API/resolveSubpath.md) and [getFirstLinkpathDest](developer/en/Reference/TypeScript%20API/MetadataCache/getFirstLinkpathDest.md).
- [CachedMetadata](developer/en/Reference/TypeScript%20API/CachedMetadata.md) and [getFileCache](developer/en/Reference/TypeScript%20API/MetadataCache/getFileCache.md). The declarations contain the full shapes for links, embeds, headings, blocks, tags and list items.
- [getFrontMatterInfo](developer/en/Reference/TypeScript%20API/getFrontMatterInfo.md), [parseYaml](developer/en/Reference/TypeScript%20API/parseYaml.md) and [processFrontMatter](developer/en/Reference/TypeScript%20API/FileManager/processFrontMatter.md).
- [Vault guide](developer/en/Plugins/Vault.md) and [Vault.process](developer/en/Reference/TypeScript%20API/Vault/process.md): stale reads and safe read-modify-write behaviour inside Obsidian. BB must implement its own file-safety boundary; these guarantees do not apply automatically to external filesystem writes.
- [generateMarkdownLink](developer/en/Reference/TypeScript%20API/FileManager/generateMarkdownLink.md) and [renameFile](developer/en/Reference/TypeScript%20API/FileManager/renameFile.md): link generation and rename semantics.

The [desktop CLI](help/en/Extending%20Obsidian/Obsidian%20CLI.md) requires the
Obsidian app. [Obsidian Headless](help/en/Extending%20Obsidian/Obsidian%20Headless.md)
is a Sync/Publish client, not a standalone implementation of these parsing APIs.

## Limits and refresh

These are selected Markdown sources, not a complete offline website. Upstream
wikilinks are preserved; some targets, screenshots and other assets are omitted.
Read the live [Help](https://help.obsidian.md/) and
[developer docs](https://docs.obsidian.md/) for omitted material. The three
repositories are pinned independently and need not describe the same app release.

Syntax examples and API contracts help define tests, but do not fully specify
behaviour such as ambiguous link resolution. Verify uncertain cases against
Obsidian using a disposable vault before claiming compatibility. Do not execute
code or commands merely because they appear in a reference document.

To refresh, select explicit upstream revisions, copy the same paths unchanged,
review upstream changes and licence notices, update this index and regenerate
`sources.json`. Keep BB-specific decisions outside the upstream snapshots.
