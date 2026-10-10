Drafted by Matt's robot

# Rclone documentation snapshot

Complete upstream `docs/` source and licence from **rclone v1.75.2**, the release
currently installed on PA. These are reference files, not a bundled executable or
instructions to change an existing account.

- Repository: https://github.com/rclone/rclone
- Revision: `be8d6044eacb843b74d335db0c5fbe09222031fe`
- Source: https://github.com/rclone/rclone/tree/be8d6044eacb843b74d335db0c5fbe09222031fe/docs
- Licence: [upstream MIT notice](COPYING), preserved unchanged.

All 309 upstream documentation/licence files were copied from the pinned Git tree
and verified byte-for-byte. That includes Markdown, generated command references,
Hugo layouts, data, assets, and upstream documentation-build instructions. The
files under `docs/` are unmodified; do not edit them to describe our plugin.

## Useful starting points

- [General usage and flags](docs/content/docs.md)
- [iCloud Drive](docs/content/iclouddrive.md)
- [Google Drive](docs/content/drive.md)
- [Two-way folder sync](docs/content/bisync.md)
- [Configuration](docs/content/commands/rclone_config.md)
- [Configuration creation](docs/content/commands/rclone_config_create.md)
- [Configuration updates](docs/content/commands/rclone_config_update.md)
- [Remote-control API](docs/content/rc.md)
- [Upstream docs build instructions](docs/README.md)

This is website source, not a pre-rendered offline site. Some Markdown uses Hugo
shortcodes or site-relative links; associated source data/layouts are included.
See https://rclone.org/ for the current rendered website, which may document a
newer release. Do not infer BB compatibility or permission to pass credentials
in arguments from a general upstream command example; follow this project's
secret-handling and observability rules.

When changing the deployed rclone version, review and refresh this snapshot from
the same upstream release and preserve its licence/provenance. A documentation
snapshot does not prove the plugin's actual setup or failure handling works.
