# Google Calendar for BB

BB-native Calendar tools for a **single-user** BB installation. Connect multiple Google accounts; each account may expose multiple calendars. The plugin does not read or modify the Pi Google Calendar extension's Desktop OAuth files.

**Bring your own Google OAuth client:** Every BB installation needs its **own Google Cloud Web application OAuth client** (client ID and secret) with that installation's HTTPS callback registered. This marketplace does not supply a shared client, hosted OAuth broker, client secret, or Google API credentials. One client on your installation can authorize multiple Google accounts; you do not need one client per account or calendar. Calendar and the optional Google Drive plugin can copy a configured Web client's ID and secret **in either direction** through server-only, plugin-verified RPC after the destination callback has been added in Google Cloud. Each keeps separate grants and settings; removing one plugin does not remove the other's copy.

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

**New to Google Cloud? Start with the [step-by-step setup guide](docs/google-oauth-setup.md).** It covers project creation, enabling the Calendar API, configuring the consent screen and scopes, creating a Web client, connecting an account in BB, and troubleshooting.

Quick checklist—do this **once per BB installation**, before connecting Google accounts:

1. Set `BB_APP_URL` to your installation's HTTPS origin, reachable in the browser where you sign in to Google. BB can remain on a private network; do not expose it publicly just for OAuth.
2. In [Google Cloud Console](https://console.cloud.google.com/auth/clients), choose a project **you control** (an existing project is fine). Enable the **Google Calendar API** and configure Google Auth Platform's branding/audience. For an External app in **Testing**, add every account you will connect as a test user. Google may show an unverified-app warning for sensitive Calendar scopes; public distribution may need verification. Testing-mode refresh tokens for these scopes may expire after seven days.
3. Under **Google Auth Platform → Clients**, use an existing Drive **Web application** client or create a new one. Add this exact **Authorized redirect URI** (replace the origin with *your* `BB_APP_URL`; no trailing slash):

   ```text
   https://<your-bb-domain>/api/v1/plugins/google-calendar/http/callback
   ```

   Before setup, the plugin displays its exact URL in **Get started** below Configuration in BB Settings. **Authorized JavaScript origins** can be left blank for this server-side flow. A Desktop OAuth client with a `localhost` redirect (such as the Pi extension's) cannot use this HTTPS callback.
4. In **BB Settings → Installed plugins → Google Calendar**, choose **Use Drive’s OAuth client** if Drive is already configured, or enter a Web **client ID** and **client secret** in Configuration. The secret is a BB secret setting; never paste it into chat or commit it to Git. Below Configuration, choose **Add account** and complete Google's consent screen. Repeat for other Google accounts; each account can access several calendars. Click **Refresh status** on returning to BB.

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

Tool results contain structured JSON text. Search deduplicates recurring event copies, preserves source calendars, and limits concurrent calendar queries. Reads never pick a default account for a single-target operation.

Writes need BB owner approval. **Notify attendees** starts unchecked: off sends `sendUpdates: none`; on sends `all`. The checkbox overrides the tool's requested notification mode, and the result reports the mode used. Technical details show the effective proposal. Older approval submissions without a checkbox also default to off. Writes never retry automatically; if the approval UI is unavailable, they fail closed.

### Repeating appointments

`gcal_create_event` accepts an optional structured `recurrence`:

```json
{
  "start": "2026-10-29T14:30:00-07:00",
  "end": "2026-10-29T17:00:00-07:00",
  "timeZone": "America/Vancouver",
  "recurrence": { "frequency": "weekly", "byDay": ["TH"] }
}
```

Supply the explicit connected `account`, `calendarId` and `summary` as usual. This example is a proposal, not an existing appointment. Without `recurrence`, one-off creation is unchanged.

| `frequency` | Repeat pattern |
| --- | --- |
| `daily` | Every N days |
| `weekly` | Every N weeks on `byDay`: 1–7 unique weekdays (`MO` through `SU`), including the first start date's weekday. Weeks start Monday. |
| `monthly` | Every N months on the first appointment's day of month |
| `yearly` | Every N years on the first appointment's month and day |

For every frequency, `interval` is 1–52, default 1. Supply `byDay` **only** for weekly repeats. Monthly/yearly dates that do not exist are **skipped, not shifted**: January 31 monthly skips February; February 29 yearly skips non-leap years. Approval calls this out. Ordinal-weekday patterns such as “last Friday”, custom RRULEs and exclusions are not supported; do not silently substitute a date-based repeat for them.

Choose one end condition, or neither:

- Omit `count` and `until` for **no end date**. Do not invent an end condition.
- `count`: 1–1000 total occurrences including the first, not elapsed months/years.
- `until`: an **inclusive occurrence-start cutoff**. Timed events require a full RFC3339 datetime with whole seconds and an explicit offset; it is normalized and reviewed in UTC. All-day events require a date (`YYYY-MM-DD`). An occurrence starting exactly at the cutoff is included; a multi-day occurrence may finish later. Never set both `count` and `until`.

Timed repeats require an explicit valid IANA `timeZone`. Start/end must contain whole seconds and matching offsets, with end after start. Invalid dates, nonexistent initial spring-gap times and conflicting offsets are rejected before provider access or approval. Explicit matching offsets disambiguate fall folds. Both supplied offsets remain visible in approval, without browser timezone reinterpretation.

All-day repeats use `allDay: true` with **date-only** start and exclusive end; omitted end means the next calendar date. They float without timezone conversion (a supplied `timeZone` has no effect):

```json
{
  "start": "2026-12-31",
  "allDay": true,
  "recurrence": { "frequency": "yearly", "until": "2030-12-31" }
}
```

Google receives **one** recurring event with the paired start/end and generated rule, not a batch of appointments. Google owns expansion and future timezone rules. Timed starts follow the IANA zone; actual occurrence ends also depend on the original duration, particularly across timezone transitions. Runtime/provider timezone databases can differ; future laws can change. The plugin does not implement its own recurrence engine. See [Google's event/recurrence model](https://developers.google.com/workspace/calendar/api/concepts/events-calendars) and [RFC 5545 recurrence rules](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).

Owner approval shows the first appointment/dates, repeat pattern, skipped-date policy when relevant, and exact end condition. Only approval inserts the event. Notifications default off; decline/cancellation creates nothing. Older pending recurring proposals without normalized review data must be declined and proposed again. Uncertain inserts are never retried automatically: inspect Google Calendar before considering another attempt.

Update/delete still target **only the exact supplied event ID**, without recurrence editing, occurrence expansion, or “this and future” support. For one appointment, use the expanded instance ID from `gcal_list_events` or `gcal_search_events`, not the series ID. Series IDs affect the whole series and require explicit user intent; approval shows verified series/occurrence scope or warns when scope is unavailable. Creation support is not permission to create the example or invite anyone.

## Development and limitations

```sh
npm install
npm test             # builds plugin, runs Cucumber core scenarios and adapter/BB fake-host tests
npm run typecheck
```

BB's `bb plugin logs google-calendar` records bounded stage/status categories for failed identity checks, partial calendar discovery/search, and agent tool failures. It never records raw Google messages, account addresses, OAuth secrets, or tool arguments. A connected identity is not proof that a Calendar API read will succeed; verify with a harmless read. Provider failures and safe recurrence diagnostics are covered by synthetic host tests; native approvals are checked in a credential-free disposable BB with no Google adapter. See [verification and remaining delivery limits](docs/recurring-creation-verification.md).

The core is in `core/`; `adapters/` contain Google HTTP and BB storage. Gherkin scenarios in `features/` drive the core through fake ports. Managed installation, HTTPS callback and multiple real account connections have previously been verified. Recurring creation has automated and isolated native-thread rendered verification. Actual Google series expansion remains unverified; payload tests are not provider write/readback evidence. A public callback accepts only an expiring, one-use state/PKCE grant initiated from BB; keep the whole BB installation private and single-user.
