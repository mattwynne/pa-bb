# Email correspondence for GTD projects

GTD project pages should link to related Fastmail and Gmail conversations and show which ones have unread messages. Obsidian owns the correspondence list. The connected mailbox owns read and unread state.

## Project note

Use a `## Correspondence` section on the project's Obsidian landing note. Store one Markdown bullet per conversation. Use the conversation's subject as the link text and its provider's conversation URL as the destination.

~~~markdown
## Correspondence

- [Workshop logistics](<conversation-url>)
- [Venue booking confirmation](<conversation-url>)
~~~

Use the same format for Fastmail and Gmail. Preserve the note's list order and use the saved URL unchanged when opening a conversation. The list travels with the landing note when the project moves. Existing links to specific messages can serve as references where they already appear. Add an existing conversation to the list once its conversation URL has been verified.

## BB display

Add **Correspondence** to the project page alongside the existing list of BB threads. Each row shows the saved subject as a link and, when available, the latest sender and message date. Show **2 unread** when two eligible messages are unread.

Refresh on opening a project, returning to the BB window, and periodically while the GTD page is visible. Share in-flight lookups across views, limit concurrency, and respect provider backoff. After the project page works, add an Area-list indicator. Show **Unread email** if at least one conversation has confirmed unread mail. Show **Mail status incomplete** if counts are missing and none of the confirmed counts are positive. Scanning the Area list requires reading correspondence sections across projects, so establish a bounded read strategy before adding the indicator.

Display supported saved links immediately. If a mailbox is disconnected, a conversation can't be resolved, or a refresh fails, keep the link usable and indicate the reason that mail status is unavailable. Show available results when only some lookups succeed. After a failed refresh, clear the unread count and label any retained sender and date with the last successful check time.

## Mailbox lookup and unread state

Give GTD a common read-only interface that takes a saved conversation URL and returns thread metadata or an explicit lookup failure. Fastmail and Google Workspace need GTD-facing RPCs for these reads. Each provider handles verified account selection, thread lookup, and link generation for new entries. A recognized link whose mailbox can't be identified can still open in the browser and shows unavailable status in BB. Keep any confirmed identity and cached metadata outside the project note. Invalidate cached data when the account changes or disconnects.

- **Fastmail** needs a verified conversation URL. Test a conversation-level route in a signed-in browser, including after archiving. The existing resolver emits exact-message links and requires a recent message lookup. Refreshing saved conversation links needs a separate account-verified JMAP read. When the connected account lacks JMAP access, show the stored link with unavailable status. [Fastmail email URL resolver](../../fastmail/docs/email-urls.md) · [JMAP thread lookup](https://www.rfc-editor.org/rfc/rfc8621.html#section-3.1)
- **Gmail** exposes a permalink in Apps Script. The Gmail REST thread response supplies thread and message data. The current Workspace connector uses browser-slot links. Use `https://mail.google.com/mail/?authuser=<encoded-mailbox-address>#all/<thread-id>` as the candidate for GTD. A manual browser test confirmed that the account-qualified inbox and a conversation link opened the intended mailbox and conversation in one session. Verify both sign-in orders with two accounts before adopting this form. The generated URL contains the mailbox address, which is stored wherever the link is saved. [Gmail thread permalink](https://developers.google.com/apps-script/reference/gmail/gmail-thread#getPermalink()) · [Gmail thread lookup](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get)

Mailbox read state is authoritative. Count eligible messages individually and take the latest sender and date from the same set. For Gmail, count `UNREAD` messages after excluding `DRAFT`, `TRASH`, and `SPAM`. For Fastmail, count messages without `$seen` after excluding drafts and messages whose only mailboxes are Trash or Junk. Archived messages count. An incomplete read leaves the count unknown. Marking a message read or unread in either mailbox changes the count on refresh. The read uses message metadata and requires no separate GTD review state. [Gmail labels](https://developers.google.com/workspace/gmail/api/guides/labels) · [JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html#section-2)

## First delivery

The project page shows saved links for both providers. Account-qualified Gmail links can show mailbox metadata. Fastmail conversation URL verification and the Area-list indicator are follow-on work.

## Implementation and acceptance

1. Prove both providers' round trip from a conversation URL to a verified account and API thread. Use already-read test conversations for browser checks. A provider whose round trip remains unproven can display saved links with unavailable status. Live status is complete when both providers pass.
2. Read the named section through Obsidian's plugin interface. The existing section RPC returns bounded Markdown text. Establish a reliable parsing path for top-level link bullets, with explicit handling of missing, ambiguous, malformed, and oversized sections. Escape Markdown characters in subjects and use `(no subject)` for an empty subject. Verify exact URL deduplication, mixed-provider lists, and project moves. Only recognized HTTPS mail origins can open from BB.
3. Add project-page details and unread counts. Test new unread mail, read and unread transitions, ambiguous accounts, deleted threads, archived mail, mixed provider availability, and failed refreshes. Verify the empty state, keyboard use, and narrow panes in running BB. Test that logs contain bounded failure categories and exclude private provider values. [Observability standards](../../../docs/o11y-standards.md)
4. Add the Area-list indicator after validating the cost of reading and refreshing correspondence across active projects.

Coordinate the GTD, Obsidian, Fastmail, and Google Workspace changes with their plugin owners. GTD should display saved links with a clear status when a provider plugin is missing or too old to supply live data.

This plan covers saved correspondence and unread indicators inside BB. Inbox matching by contact or text similarity is a follow-on that can add links using the same note format.
