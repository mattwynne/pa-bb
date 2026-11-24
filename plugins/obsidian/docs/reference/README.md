# Obsidian references

Use [Obsidian Help](https://help.obsidian.md/) for vault formats and workflows and the [developer documentation](https://docs.obsidian.md/) for the APIs available inside Obsidian. The BB plugin uses the following references when interpreting notes and testing its own behavior.

## Reading a vault

| Topic | Obsidian Help |
| --- | --- |
| Markdown and tasks | [Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown), [basic syntax](https://help.obsidian.md/syntax), [advanced syntax](https://help.obsidian.md/advanced-syntax), [callouts](https://help.obsidian.md/callouts), [HTML](https://help.obsidian.md/html) |
| Link targets and metadata | [Internal links, headings and blocks](https://help.obsidian.md/links), [aliases](https://help.obsidian.md/aliases), [embeds](https://help.obsidian.md/embeds), [properties](https://help.obsidian.md/properties), [tags](https://help.obsidian.md/tags) |
| Files and paths | [Data storage](https://help.obsidian.md/data-storage), [configuration folder](https://help.obsidian.md/configuration-folder), [symbolic links](https://help.obsidian.md/symlinks), [attachment locations](https://help.obsidian.md/attachments), [settings](https://help.obsidian.md/settings) |
| Finding notes | [Search](https://help.obsidian.md/plugins/search), [backlinks](https://help.obsidian.md/plugins/backlinks), [outgoing links](https://help.obsidian.md/plugins/outgoing-links) |
| Other vault features | [Daily notes](https://help.obsidian.md/plugins/daily-notes), [templates](https://help.obsidian.md/plugins/templates), [Canvas](https://help.obsidian.md/plugins/canvas), [Bases syntax](https://help.obsidian.md/bases/syntax), [Obsidian URI](https://help.obsidian.md/uri) |
| External tools | [Desktop CLI](https://help.obsidian.md/cli), [Obsidian Headless](https://help.obsidian.md/headless) |

## Developer API

| Question | Developer documentation |
| --- | --- |
| How does Obsidian resolve a link or a heading within its target? | [parseLinktext](https://docs.obsidian.md/Reference/TypeScript+API/parseLinktext), [getFirstLinkpathDest](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache/getFirstLinkpathDest), [resolveSubpath](https://docs.obsidian.md/Reference/TypeScript+API/resolveSubpath) |
| Which metadata does Obsidian keep for a note? | [CachedMetadata](https://docs.obsidian.md/Reference/TypeScript+API/CachedMetadata), [getFileCache](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache/getFileCache) |
| How does Obsidian read and update frontmatter? | [getFrontMatterInfo](https://docs.obsidian.md/Reference/TypeScript+API/getFrontMatterInfo), [parseYaml](https://docs.obsidian.md/Reference/TypeScript+API/parseYaml), [processFrontMatter](https://docs.obsidian.md/Reference/TypeScript+API/FileManager/processFrontMatter) |
| How does Obsidian read, edit or move a note? | [Vault guide](https://docs.obsidian.md/Plugins/Vault), [Vault.read](https://docs.obsidian.md/Reference/TypeScript+API/Vault/read), [Vault.process](https://docs.obsidian.md/Reference/TypeScript+API/Vault/process), [generateMarkdownLink](https://docs.obsidian.md/Reference/TypeScript+API/FileManager/generateMarkdownLink), [renameFile](https://docs.obsidian.md/Reference/TypeScript+API/FileManager/renameFile) |

The [API declarations](api/obsidian.d.ts) and [Canvas types](api/canvas.d.ts) describe interfaces supplied by Obsidian. BB provides its own safeguards for external file edits. For behavior the declarations leave open, such as resolving ambiguous links, verify against Obsidian in a disposable vault.

## Sources and redistribution

- **Help.** We found no redistribution grant for the documentation at the [Help revision originally consulted](https://github.com/obsidianmd/obsidian-help/tree/b95e59dab8b5d94ff06376f1437c8492f14da80d). Keep Help articles upstream and link to them here.
- **Developer documentation.** The [revision originally consulted](https://github.com/obsidianmd/obsidian-developer-docs/tree/c56c7e770ba25dd0ea392aacf4588f9425970d36) predates the current license notice. Dynalist reserves the prose and images. The 0BSD permission applies only to code examples in fenced code blocks. Link to the articles when updating this index. [Upstream license](https://github.com/obsidianmd/obsidian-developer-docs/blob/cb40935138c857119e2520c5fefbd9fbb2dbadf6/LICENSE)
- **API.** The [pinned API repository](https://github.com/obsidianmd/obsidian-api/tree/9abd9605ce081383674aae1ed111c456edde0688) licenses its files under MIT. The [manifest](sources.json) records the paths and SHA-256 checksums of the two declarations, package metadata, README and [copyright and permission notice](api/LICENSE.md). When refreshing the API, review the license at the new revision, preserve its notice alongside the files, and update the manifest from the upstream bytes.
