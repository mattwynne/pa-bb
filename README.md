# PA for BB

**Turn BB into a personal assistant for your life.**

[BB](https://getbb.app) is an app for working with AI coding agents such as Claude Code, Codex and Pi. PA for BB extends it beyond coding: connect your calendar, email, documents and notes, then ask your assistant to help with the things you need to do.

- “What do I need to prepare for tomorrow's meetings?”
- “Find the planning document in Google Drive and summarise it.”
- “Find the open tasks in my project notes and add a note about today's decision.”

Choose the integrations you need and use them together in BB conversations. The goal is an assistant that helps you prepare, plan and follow through—not just a collection of service connections. See [the vision](docs/vision.md) for the intended experience; today's available plugins are listed below.

For a new installation, use the [Docker quick start](#docker-quick-start) or [Ansible/manual host setup](#ansible-or-manual-setup). Docker includes BB, the PA plugins and their dependencies. Already running BB? [Add the integrations you want](#2-add-the-marketplace-and-install-plugins).

## Available integrations

| Integration | What you can do | What you need |
| --- | --- | --- |
| [Google Workspace](plugins/google-workspace/README.md) | Use Drive, Docs, Sheets, Calendar and Gmail across connected Google accounts. Requested writes run without a second PA approval prompt. | Your own Google Web OAuth client and `uvx` on the BB service's PATH. [Setup guide](plugins/google-workspace/README.md#setup). |
| [Fastmail](plugins/fastmail/README.md) | Use Fastmail's mail, calendar and contacts tools. Available actions depend on the access you grant, including write/send access if selected. An optional API token enables Inbox and label updates. | One Fastmail account. [Setup guide](plugins/fastmail/docs/setup.md). |
| [iCloud Drive](plugins/icloud/README.md) | Sync selected folders in both directions between iCloud Drive and the BB host. | A supported Linux host with rclone. [Setup and recovery guide](plugins/icloud/docs/setup.md). |
| [Obsidian](plugins/obsidian/README.md) | Search, read, create and edit Markdown notes, properties and tasks across connected vaults. No Obsidian app or Mac relay required. | The iCloud plugin, an initialized synced vault, and the [host search requirements](provisioning/README.md). [Setup guide](plugins/obsidian/docs/setup.md). |

These plugins are early-stage and intended for **single-user BB installations**, not shared servers. Listed capabilities are implemented, but not every action has been verified against a live account. Google Workspace replaces the retired standalone Calendar and Drive plugins. Each plugin guide records verification limits; an available tool catalog is not proof of every provider operation. PA core and other [planned integrations](docs/roadmap.md) are not available yet.

### Experimental GTD inventories

The source checkout also includes a read-only [GTD plugin](plugins/gtd/README.md) with `bb gtd projects`, `bb gtd areas`, and corresponding agent tools. Its backend-independent model starts with an Obsidian adapter for configured Projects and Areas folders. Folder membership defines entries; no type property is required. It is not yet listed in the marketplace; see its guide for local installation and verification limits.

## Get started

### 1. Prepare the host

#### Docker quick start

On a **linux/amd64** Docker host:

```sh
git clone https://github.com/mattwynne/pa-bb.git
cd pa-bb
docker build --platform linux/amd64 -t pa-bb .
docker volume create pa-bb-home
docker run -d --name pa-bb \
  -p 127.0.0.1:38886:38886 \
  --mount source=pa-bb-home,target=/home/bb \
  --shm-size=1g --stop-timeout=60 \
  pa-bb
```

Open <http://localhost:38886> and finish BB setup. The container runs as a non-root
user and stores settings, credentials, synced files and workspaces in the named
volume. Keep it private and back it up; don't replace it with an empty bind mount.
For remote access, use an SSH tunnel or an authenticated TLS reverse proxy.

The [`Dockerfile`](Dockerfile) uses `node:24-bookworm-slim` and installs dependencies
directly—no Ansible or systemd. It includes BB, Pi, Codex, Claude Code, Hermes,
uv/uvx, rclone, ripgrep and Chrome. Startup registers the PA plugins and official
Browser Automation, so **skip step 2** and [connect your services](#3-connect-your-services).
No accounts are connected and no sync is enabled automatically.

See the [container guide](docker/README.md) for logs, provider sign-in, persistence
and safe updates. The image build and container runtime have not yet been verified;
current checks cover startup logic, shell syntax and dependency-pin alignment.

#### Ansible or manual setup

For manual setup, install [BB](https://getbb.app) **0.45 or later**, with Node.js **22 or later**, and configure an AI provider. The host is the computer running BB; it need not be the computer where you open its browser interface. Keep this installation private and for your own use.

**For iCloud and Obsidian, provision the Linux dependencies before installing the plugins.** The included [Ansible role and setup instructions](provisioning/README.md) make that repeatable:

- Supported provisioning target: **Ubuntu 24.04, x86_64**.
- Pinned rclone **1.75.2** for iCloud folder sync and ripgrep **14.1.0** for note search.
- Required locking and process-inspection support for safe background syncing.

Use the dependency role from a reviewed Git revision in your own infrastructure project, or follow the [standalone playbook instructions](provisioning/README.md#consume-from-infrastructure). The dependency role installs host packages, including native Chrome; it does not install BB. The full [application playbook](provisioning/application.md) also installs stock BB and agent tools, configures the service, registers PA plugins and installs official Browser Automation. Neither route connects accounts or enables sync. You supply the machine, persistent storage and private configuration. The plugins never install system packages themselves.

Fastmail and Google Workspace do not need these iCloud/Obsidian dependencies. Workspace requires `uvx`; see its setup guide.

### 2. Add the marketplace and install plugins

**Using Docker or the full Ansible application playbook?** The PA plugins are already registered; continue to [step 3](#3-connect-your-services). These marketplace instructions are for an existing BB installation where you want to choose individual integrations.

The marketplace is a plugin catalog you add to BB. Adding it gives you a choice of integrations; it does not install them all. Add it once, then install a plugin—for example, Fastmail:

```sh
bb marketplace add git:https://github.com/mattwynne/pa-bb.git
bb marketplace refresh pa-for-bb
bb plugin install fastmail@pa-for-bb
```

If the marketplace is already registered, skip the first command. Replace `fastmail` with `google-workspace`, `icloud` or `obsidian` to install another integration. Adding or refreshing the marketplace **does not install or update plugins**.

### 3. Connect your services

Open the installed plugin's settings in BB and follow its setup guide. Then start a **fresh BB conversation** so the assistant can discover its tools. No service is connected merely by installing a plugin.

### Before connecting accounts

- **Google setup needs your own client.** Create a Google Cloud Web OAuth client and register the callback URL shown in BB. The marketplace supplies no shared Google credentials. Workspace requests combined access to Drive, Docs, Sheets, Calendar and Gmail.
- **Fastmail controls the granted access.** Choose the permissions at Fastmail sign-in. If the browser cannot open the final localhost redirect, paste that address into the plugin's protected field in BB—not into chat or logs.
- **Write permissions differ.** Workspace and Fastmail follow the access you grant without an extra plugin-specific confirmation. Connecting an Obsidian vault grants read/write access to the **whole vault**, including hidden folders, without per-edit confirmations.
- **Sync is not a backup.** iCloud changes and deletions can propagate both ways. An Obsidian save confirms a local save, not delivery to iCloud or another device. Use a disposable folder for your first sync test and keep separate backups.

## A look inside BB

These screenshots show the installed plugins in BB with **example accounts and vault data**, not real connected accounts. See [how they were captured](docs/screenshots/README.md).

### Connect your notes

![Obsidian settings in BB, showing an example connected project-notes vault.](docs/screenshots/obsidian.png)

## Further reading

- [Contributing](CONTRIBUTING.md) — local-path development with stock BB: edit → reload → try → commit/push, tests and shared UI workflow.
- [Vision](docs/vision.md) and [roadmap](docs/roadmap.md) — where the project is heading.
- [Plans and findings](docs/plans/README.md) — implementation history and verification evidence.
- [Docker deployment](docker/README.md) — build, run, persistent storage and updates.
- [Host provisioning](provisioning/README.md) — Linux dependency requirements and Ansible application setup.
- [BB references](docs/references/README.md) and [`marketplace.json`](marketplace.json) — host documentation and plugin catalog.
