---
name: obsidian-links
description: Choose and verify links when writing or editing Obsidian notes, including vault notes and attachments, Google Drive items, and local files.
---

# Links in Obsidian notes

- Use Obsidian internal links for notes and attachments in the same vault. Preserve the note's existing link style and use a vault-relative target when the name alone is ambiguous. Resolve existing internal links with `obsidian_resolve_link` when their target is unclear.
- For a Google Drive file or folder, use a verified HTTPS link to the exact item. Use the link returned by the connected Drive tools for that item.
- Omit `file://` links and absolute local filesystem paths as link targets for files or folders outside the vault.
