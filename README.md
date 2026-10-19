# PA for BB

**Use your BB assistant with your calendar, email, documents and notes.**

PA for BB is a collection of optional plugins for [BB](https://getbb.app). They let your assistant work with the services you already use, so you can ask questions and get things done without switching between apps:

- “What's on my calendars tomorrow?”
- “Find the planning document in Google Drive and summarise it.”
- “Find the open tasks in my project notes and add a note about today's decision.”

Install only the integrations you want, connect your accounts, then use them in BB conversations. BB is the app; this repository supplies the plugins and the marketplace that lists them. You do not need a separate PA application.

## Available integrations

| Integration | What you can do | What you need |
| --- | --- | --- |
| [Google Calendar](plugins/google-calendar/README.md) | Search events, check availability, and create, update or delete events after approval. Connect multiple Google accounts. | Your own Google Web OAuth client. [Setup guide](plugins/google-calendar/docs/google-oauth-setup.md). |
| [Fastmail](plugins/fastmail/README.md) | Use Fastmail's mail, calendar and contacts tools. Available actions depend on the access you grant, including write/send access if selected. An optional API token enables Inbox and label updates. | One Fastmail account. [Setup guide](plugins/fastmail/docs/setup.md). |
| [Google Drive & Docs](plugins/google-drive/README.md) | Find files, browse folders and read Google Docs across connected accounts. **Read-only.** | Your own Google Web OAuth client; Calendar and Drive can reuse its configuration while keeping separate account grants. [Setup guide](plugins/google-drive/docs/setup.md). |
| [iCloud Drive](plugins/icloud/README.md) | Sync selected folders in both directions between iCloud Drive and the BB host. | A supported Linux host with rclone. [Setup and recovery guide](plugins/icloud/docs/setup.md). |
| [Obsidian](plugins/obsidian/README.md) | Search, read, create and edit Markdown notes, properties and tasks across connected vaults. No Obsidian app or Mac relay required. | The iCloud plugin, an initialized synced vault, and the [host search requirements](provisioning/README.md). [Setup guide](plugins/obsidian/docs/setup.md). |

These plugins are early-stage and intended for **single-user BB installations**, not shared servers. Listed capabilities are implemented, but not every action has been verified against a live account. In particular, live Google Drive sign-in/reads, Calendar tool/approval flows, and Fastmail writes remain unverified; each plugin guide records its limits. PA core and other [planned integrations](docs/roadmap.md) are not available yet.

## A look inside BB

These screenshots show the installed plugins in BB with **example accounts and vault data**, not real connected accounts. See [how they were captured](docs/screenshots/README.md).

### Connect more than one calendar account

![Google Calendar settings in BB, showing two example connected Google accounts.](docs/screenshots/google-calendar.png)

### Connect your notes

![Obsidian settings in BB, showing an example connected project-notes vault.](docs/screenshots/obsidian.png)

## Get started

You need BB **0.45 or later** and Node.js **22 or later**. iCloud and Obsidian also need the [Linux host dependencies](provisioning/README.md).

Add the marketplace once, then install a plugin—for example, Fastmail:

```sh
bb marketplace add git:https://github.com/mattwynne/pa-bb.git
bb marketplace refresh pa-for-bb
bb plugin install fastmail@pa-for-bb
```

If the marketplace is already registered, skip the first command. Replace `fastmail` with `google-calendar`, `google-drive`, `icloud` or `obsidian` to install another integration. Adding or refreshing the marketplace **does not install or update plugins**.

Open the installed plugin's settings in BB and follow its setup guide. Then start a **fresh BB conversation** so the assistant can discover its tools. No service is connected merely by installing a plugin.

### Before connecting accounts

- **Google setup needs your own client.** Create a Google Cloud Web OAuth client and register the callback URL shown in BB. The marketplace supplies no shared Google credentials. Calendar and Drive keep separate permissions even if they share client configuration.
- **Fastmail controls the granted access.** Choose the permissions at Fastmail sign-in. If the browser cannot open the final localhost redirect, paste that address into the plugin's protected field in BB—not into chat or logs.
- **Write permissions differ.** Calendar changes require approval. Fastmail follows the access you grant without an extra plugin-specific confirmation. Connecting an Obsidian vault grants read/write access to the **whole vault**, including hidden folders, without per-edit confirmations.
- **Sync is not a backup.** iCloud changes and deletions can propagate both ways. An Obsidian save confirms a local save, not delivery to iCloud or another device. Use a disposable folder for your first sync test and keep separate backups.

## Development

The repository root is a marketplace catalog, not an installable plugin. Each package lives under `plugins/` and builds independently. To work on one:

```sh
npm install --prefix plugins/fastmail
npm --prefix plugins/fastmail test
npm --prefix plugins/fastmail run typecheck
```

Replace `fastmail` with the package you are changing. Check the [plugin guides](#available-integrations) for additional requirements and verification steps. Calendar's tests also validate the marketplace catalog; Drive's tests build the sibling Calendar package for cross-plugin checks.

Shared connection-screen source lives in `shared/connection-ui/`; plugins carry generated copies so they can be installed separately:

```sh
node scripts/sync-connection-ui.mjs          # regenerate after editing shared source
node scripts/sync-connection-ui.mjs --check  # check for drift
```

See the [shared UI guide](shared/connection-ui/README.md), [UX standards](docs/ux-standards.md) and [observability standards](docs/o11y-standards.md). [Verification fixtures](fixtures/README.md) contain standalone generated-data checks; a reusable [local integration-test environment](docs/problems/local-integration-test-environment.md) is still needed.

## Further reading

- [Vision](docs/vision.md) and [roadmap](docs/roadmap.md) — where the project is heading.
- [Plans and findings](docs/plans/README.md) — implementation history and verification evidence.
- [Host provisioning](provisioning/README.md) — portable Linux dependency requirements and Ansible role.
- [BB references](docs/references/README.md) and [`marketplace.json`](marketplace.json) — host documentation and plugin catalog.
