# Connection UI

This is the source of the small shared settings UI used by service plugins: headings, account rows, status, buttons, onboarding, alerts, and footer. Google Calendar supplies the established visual pattern; each plugin keeps its provider-specific form and connection logic.

BB installs each marketplace plugin from its own subdirectory. To keep those packages independently buildable, run `node scripts/sync-connection-ui.mjs` after editing these files. It writes checked-in copies to `plugins/google-calendar/` and `plugins/fastmail/`; `--check` fails on drift. A new service plugin should be added to the script only when it needs the shared connection pattern, then reviewed in a running BB instance at desktop and narrow widths. Do not edit the generated copies.

Only put UI shared by at least two plugins here. This is not a service-account model, an OAuth abstraction, or an authorization policy. A provider-specific screen must not invent an account identity or access scope just to fill an account row.
