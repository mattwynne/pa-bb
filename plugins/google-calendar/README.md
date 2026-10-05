# Google Calendar for BB

BB-native Calendar tools for a **single-user** BB installation. Connect multiple Google accounts; each account may expose multiple calendars. The plugin does not read or modify the Pi Google Calendar extension's Desktop OAuth files.

**Bring your own Google OAuth client:** Every BB installation needs its **own Google Cloud Web application OAuth client** (client ID and secret) with that installation's HTTPS callback registered. This marketplace does not supply a shared client, hosted OAuth broker, client secret, or Google API credentials. One client on your installation can authorize multiple Google accounts; you do not need one client per account or calendar.

> This plugin is not safe for a multi-user BB installation: BB agent tools and plugin routes do not supply a user identity. Do not install where another person can use your BB instance.

## Install

On BB 0.45.0 or later, add the [PA-for-BB Git marketplace](../../marketplace.json), then install its Calendar entry:

```sh
bb marketplace add git:https://github.com/mattwynne/pa-bb.git@main
bb marketplace refresh pa-for-bb
bb plugin install google-calendar@pa-for-bb
```

If `pa-for-bb` is already registered, do not add it twice: run `bb marketplace list` to check its source, then refresh it. Installing the plugin is separate from adding the marketplace. Start a **fresh BB provider session** after installation to see its tools.

## Set up your own Google OAuth client

Do this **once per BB installation**, before connecting Google accounts:

1. Set `BB_APP_URL` to your installation's HTTPS origin, reachable in the browser where you sign in to Google. For Matt's PA host this is `https://pa.home.wynne.family`. BB can remain on a private network; do not expose it publicly just for OAuth.
2. In [Google Cloud Console](https://console.cloud.google.com/auth/clients), choose a project **you control** (an existing project is fine). Enable the **Google Calendar API** and configure Google Auth Platform's branding/audience. For an External app in **Testing**, add every account you will connect as a test user. Google may show an unverified-app warning for sensitive Calendar scopes; public distribution may need verification. Testing-mode refresh tokens for these scopes may expire after seven days.
3. Under **Google Auth Platform → Clients**, create a new client of type **Web application**. Add this exact **Authorized redirect URI** (replace the origin with *your* `BB_APP_URL`; no trailing slash):

   ```text
   https://<your-bb-domain>/api/v1/plugins/google-calendar/http/callback
   ```

   For Matt's PA host: `https://pa.home.wynne.family/api/v1/plugins/google-calendar/http/callback`. The plugin also displays its exact URL under **OAuth setup & troubleshooting** in BB Settings. **Authorized JavaScript origins** can be left blank for this server-side flow. A Desktop OAuth client with a `localhost` redirect (such as the Pi extension's) cannot use this HTTPS callback.
4. In **BB Settings → Installed plugins → Google Calendar → Configuration**, enter your new Web **client ID** and **client secret**. The secret is a BB secret setting; never paste it into chat or commit it to Git. Under **Google Calendar accounts**, choose **Add account** and complete Google's consent screen. Repeat for other Google accounts; each account can access several calendars. Click **Refresh status** on returning to BB.

If you deploy another BB installation, repeat these steps with **that installation's own client and redirect URI**. Google grants and refresh tokens are tied to the client that issued them; do not copy the Pi Desktop grant or another installation's tokens into this plugin.

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
npm test             # builds plugin, runs Cucumber core scenarios and adapter/BB fake-host tests
npm run typecheck
```

The core is in `core/`; `adapters/` contain Google HTTP and BB storage. Gherkin scenarios in `features/` drive the core through fake ports. A managed Git install, HTTPS callback, and two real account connections have been verified on Matt's PA BB host. End-to-end Calendar tool use and the live write-approval UI still require verification. A public callback accepts only an expiring, one-use state/PKCE grant initiated from BB; keep the whole BB installation private and single-user.
