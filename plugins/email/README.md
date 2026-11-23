# Email

Search mail from selected Google Workspace Gmail accounts and the authenticated primary Fastmail account in a local [MsgVault](https://www.msgvault.io/) archive.

## Setup

1. The [Docker image](../../docker/README.md) includes BB 0.50.1 and MsgVault 0.26.0. For another installation, install [MsgVault 0.26](https://github.com/kenn-io/msgvault/releases) on the BB server and use BB 0.50.1 or later. The `msgvault` executable must be on the BB service’s PATH. Existing Docker homes may still need a BB update through its native controls; replacing the image does not replace the home's installed BB. This integration is tested with MsgVault 0.26.0.
2. Update the Google Workspace and Fastmail plugins to versions that support Email indexing. For Gmail, connect the Google account in [Google Workspace](../google-workspace/README.md) settings. For Fastmail, configure the [JMAP mail API token](../fastmail/docs/setup.md) in Fastmail Configuration. The Fastmail sending aliases and its MCP connection identify a different surface and cannot authorize this archive.
3. Install Email and open its settings in BB. Choose **Index account** for each mailbox to copy. BB starts a scan and continues in the background in bounded batches. Use **Scan now** to request another pass or resume from the saved position.

The provider plugins keep the credentials and make read-only Gmail and JMAP calls using the permissions already granted. MsgVault runs locally with one archive per account. A paused account stays on disk and is hidden from the search and read tools until it is resumed. The archive is stored under the Email plugin’s server data directory and can grow with the size of the selected mailboxes. Keep it on private storage and include it in any backups that should retain mail.

Scans run again six hours after completing. Search is available during the initial scan as soon as mail has been imported. The archive captures raw messages up to 32 MiB, including their original MIME. It provides text search and bounded plain-text reads, and does not mirror provider folders, label changes, or deletions. Messages larger than the cap are counted separately in settings. Provider messages that disappear during the scan may be omitted. Attachments are kept inside their original messages. Email does not extract or expose attachment files.

## Agent tools

- `email_indexed_accounts` lists the selected accounts and scan coverage.
- `email_search` accepts terms, phrases and [MsgVault search operators](https://www.msgvault.io/docs/cli-reference/#search), such as `subject:invoice after:2026-01-01`. It can search across selected accounts or use an exact account key from the inventory. Output includes a bounded preview and an indication of incomplete coverage.
- `email_read` reads plain text from a search result using its account key and numeric message ID.

BB logs fixed discovery, indexing, and MsgVault failure categories. For a provider failure, check the upstream plugin’s bounded archive diagnostic. A successful scan records the end of a provider traversal and does not establish that the live mailbox has stayed unchanged.
