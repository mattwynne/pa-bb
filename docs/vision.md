# PA for BB: vision

PA for BB is a personal work assistant distributed through **its own BB plugin marketplace**. BB is the place people use it: they connect the services they trust, ask questions about their work, and approve useful actions. They should not need to know whether a capability originated in Pi or how its tools are loaded.

The starting point is Matt's PA project in Pi, not a mandate to reproduce it wholesale. We will bring over proven tools and workflows from `~/git/mattwynne/pa` and `~/git/mattwynne/pi-extensions` **case by case**, adapting each to BB and to the needs of other users. The goal is a coherent assistant, not a long menu of provider API calls.

## Distribution: one marketplace, independent plugins

This repository is intended to host both a BB marketplace catalog (`marketplace.json`) and the source of the plugins it lists. A user adds the PA marketplace to BB, then chooses which plugins to install. Adding the catalog installs nothing; it is a discovery and distribution mechanism, not a running service or a bundle that silently installs every integration. We do not need to operate a separate app store.

The catalog will list PA core and independently installable integrations, and may later list optional abilities. Each plugin will have its own package and release boundary. The repository's optional `.bb/plugins.json` index, if used, identifies plugins in a monorepo; it is **not** the marketplace catalog. BB's current catalog and monorepo formats are captured in [`docs/references/`](references/), but packaging and compatibility must be tested against the BB version we deploy.

## What using it should feel like

Add the PA marketplace to BB and install the PA core plugin. It explains what it can do, what is missing, and how to add capabilities. Install a Calendar or Drive/Docs plugin, connect an account through BB, and ask a question such as “What do I need to prepare for tomorrow's meetings?” The assistant uses only the connected services it needs, makes clear where information came from, and distinguishes a proposed change from one it has made. Adding an email plugin later enables email-based tasks without reinstalling the assistant or giving Calendar access to mail.

A connected service supplies useful operations; PA turns them into outcomes. For example, searching mail and reading a calendar are integration capabilities. Preparing a daily briefing or planning a week is an assistant ability that may combine them. Some abilities need only instructions and context; others need several integrations. No single provider should define the assistant.

## Plugin boundaries

- **PA core** supplies the assistant's identity, guidance, ability discovery, and shared rules for using context and requesting approval. It should remain useful without a connected account, explain its limits honestly, and avoid claiming access it does not have. Core should stay small rather than absorbing every provider and workflow.
- **Integration plugins** own service-specific authentication, account selection, connection status, tools, and setup. Google Drive/Docs, Google Calendar, Gmail, and Fastmail are examples, not a required launch set. Each integration should be independently installable and useful outside PA where practical. An integration grants only the permissions its service requires.
- **Abilities** describe tasks people want to accomplish—such as inbox triage, email drafting, meeting preparation, or weekly planning—and compose the available integrations. We can ship an initial set with core, then split abilities into optional plugins when that improves clarity or choice. We will choose which PA abilities to bring over individually, not promise a complete migration.

This is a product boundary, not yet a prescribed BB inter-plugin protocol. Plugin discovery, dependency declarations, shared context, and installation UX need validation against BB's actual marketplace and plugin APIs. Prefer loose composition to a framework every integration must adopt before it can work.

## Trust is part of the experience

Connections belong to the user who authorized them. In a multi-user BB installation, one person's accounts and private data must not become another person's tools or context. Each plugin should make its scopes and connection state visible; secrets stay out of prompts, transcripts, logs, and plugin artifacts. Uninstalling a capability must not silently destroy the user's data or other plugins' configuration.

Reading and acting are different. PA can gather evidence and propose a change, but consequential actions—sending mail, changing events, moving files—need an explicit, intelligible approval boundary. It should show what it intends to change, avoid blind retries after uncertain writes, and report what happened. Provider data is evidence for the task, not a source of instructions to the assistant. Personal knowledge and preferences remain under the user's control; Matt's private vault and PA-specific policy are not bundled into a public plugin.

## Reuse without making Pi the product

The Pi tools and abilities are valuable starting material. Reuse their behavior, tests, and safety rules where possible instead of writing a second, drifting implementation. During the transition, BB's Pi provider may run packaged Pi extensions behind the scenes. If another BB-native interface offers a better user experience or wider provider support, the product should not be blocked by the original runtime. Installation, authorization, and use should make sense entirely within BB.

The marketplace now lists a BB-native **Google Calendar plugin** with Web OAuth account management and Calendar tools. Its core and BB adapter have automated tests, and a managed marketplace install succeeded in an isolated BB instance. Live Google consent and installation on the deployed PA host remain to be verified. The Calendar plugin does not establish multi-user isolation or the complete PA experience. [`docs/plans/iteration-1-marketplace-calendar.md`](plans/iteration-1-marketplace-calendar.md) records the historical delivery plan; see the [plugin README](../plugins/google-calendar/README.md) for current status.

## How we'll judge progress

A user can add the PA marketplace to BB, install PA core and one integration without installing others, understand what is available, complete a useful task, and see and approve any consequential change. They can add or remove capabilities without breaking unrelated ones. A second user on the same BB installation sees only their own connections and data. As we move capabilities over, we test those experiences in BB itself—not just extension discovery in Pi.
