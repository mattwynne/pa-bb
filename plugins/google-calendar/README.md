# Google Calendar for BB

BB-native Calendar tools for a **single-user** BB installation. Connect multiple Google accounts; each account may expose multiple calendars. The plugin owns Web OAuth credentials and grants in BB's plugin storage and does not read or modify the Pi Google Calendar extension's Desktop OAuth files.

> This plugin is not safe for a multi-user BB installation: BB agent tools and plugin routes do not supply a user identity. Do not install where another person can use your BB instance.

## Install

On BB 0.45.0 or later, add the [PA-for-BB Git marketplace](../../marketplace.json), then install its Calendar entry:

```sh
bb marketplace add git:https://github.com/mattwynne/pa-bb.git@main
bb marketplace refresh pa-for-bb
bb plugin install google-calendar@pa-for-bb
```

If `pa-for-bb` is already registered as a local `path:` marketplace, switch its source before adding the Git catalog. The PA container's `hub.local` provisioner currently enforces the local source; change that provisioner before switching or it may restore the old catalog on its next run. Installing the plugin is separate from adding the marketplace. Start a **fresh BB provider session** after installation to see its tools.

## Configure Google

1. Configure BB with an HTTPS `BB_APP_URL` reachable by the browser used for Google sign-in. On Matt's PA installation it is `https://pa.home.wynne.family`; do not expose it publicly just for OAuth.
2. Create/select your Google Cloud project, enable **Google Calendar API**, and configure the consent audience. For an External app in Testing, add each account as a test user; Calendar-scope refresh tokens may expire after seven days. Production/external use may need verification.
3. Create an OAuth client of type **Web application** (not Desktop). Add the plugin's exact authorized redirect URI, displayed under Google Calendar in BB Settings. For the PA installation it should be `https://pa.home.wynne.family/api/v1/plugins/google-calendar/http/callback`.
4. In BB Settings → Installed plugins → Google Calendar, enter the Web OAuth client ID and client secret. The secret is a BB secret setting; do not paste it into chat or commit it. In the plugin's connections section, choose **Connect Google account** and complete Google's consent screen. Repeat for each account. Refresh status or remove one account there; Remove deletes its local grant only and does not revoke access at Google.

The plugin requests only these scopes:

- `openid`, `email` (verify stable Google subject and email)
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.freebusy`

Each Google account's calendar list supplies its primary, selected, shared, and other calendars. You do **not** authenticate separately to each calendar. Existing Desktop grants from Pi cannot be used by this Web client: reconnect each account in BB. Grants persist in BB plugin-owned SQLite storage; treat BB's persistent home and backups as sensitive. Reauthorize by removing and reconnecting an account. Do not remove unrelated Pi credentials.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `gcal_auth_status` | Connected accounts and reauthorization status |
| `gcal_list_calendars` | Discover all accessible calendars, preserving partial success |
| `gcal_search_events` | Search selected + primary calendars across accounts; filter accounts/calendars explicitly |
| `gcal_list_events`, `gcal_get_event` | Read one explicit account/calendar |
| `gcal_free_busy` | Query busy blocks for explicit calendar IDs |
| `gcal_create_event`, `gcal_update_event`, `gcal_delete_event` | Change an explicit account/calendar after BB owner approval |

Tool results contain structured JSON text. Search deduplicates recurring event copies, preserves source calendars, and limits concurrent calendar queries. Reads never pick a default account for a single-target operation. Writes present a BB approval form with the **full proposed arguments**, default attendee notifications to `none`, and never retry an uncertain failed write. If the approval UI is unavailable, the write fails closed.

## Development and limitations

```sh
npm install
npm test             # builds plugin, runs 31 Cucumber core scenarios and adapter/BB fake-host tests
npm run typecheck
```

The core is in `core/`; `adapters/` contain Google HTTP and BB storage. Gherkin scenarios in `features/` drive the core through fake ports. Fake-host tests establish tool/route/RPC registration, not a live Google consent screen. A real BB marketplace install, callback through the deployed HTTPS proxy, two live accounts, and write approval require end-to-end verification before relying on the plugin for personal data. A public callback accepts only an expiring, one-use state/PKCE grant initiated from BB; keep the whole BB installation private and single-user.
