# Email Unsubscribe

Ask BB to unsubscribe from an exact message in Gmail or Fastmail. The
`email_unsubscribe` tool takes `provider`, `account`, and `emailId`. Use the
connected Gmail address, or the authenticated Fastmail JMAP address or account
ID. A thread ID or a sending alias is insufficient evidence of the source.

Both integrations need their existing mailbox connection. Fastmail uses its
JMAP token. For `mailto:` requests, Gmail uses its existing Gmail modify scope
and Fastmail uses JMAP submission if the current grant allows it. Only a
matching primary delivery address can be used to send or to fill a page.

The tool renders the selected message locally from bounded MIME supplied by
the connected provider. It can submit a signed RFC 8058 request, recognize a
confirmation page, submit a simple same-origin HTTPS form, call a browser
worker for interactive pages, or send an unsubscribe email. It reports an
accepted request separately from a confirmation. A receipt prevents automatic
repeat submissions for the same account and message after an uncertain result.
An interrupted receipt requires manual follow-up.

## Browser fallback

Configure **Browser worker HTTPS origin** and **Browser worker secret** in
Email Unsubscribe settings to use a trusted, separately operated
[Inbox Zero-compatible unsubscribe worker](https://github.com/elie222/inbox-zero/blob/2784eff8ac5781480609a27e16d17afd365b88bc/apps/unsubscribe-worker/README.md).
The worker must provide a fresh isolated browser and restrict its egress.
BB sends only the per-job ID, the unsubscribe URL and the verified delivery
address to the worker's authenticated `/jobs` endpoint. The worker may send
page text to its configured model. The rest of the tool is available without
a worker. Interactive pages then require manual follow-up.

Provider messages and link tokens can contain personal data. Diagnostics
give fixed failure categories and omit URLs, response bodies, and account
details. Browser or form results describe the response received, and future
delivery can take time to change.
