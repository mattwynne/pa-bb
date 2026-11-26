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
confirmation page, submit a simple same-origin HTTPS form, start a BB browser
subthread for interactive pages, or send an unsubscribe email. It reports an
accepted request separately from a confirmation. A receipt prevents automatic
repeat submissions for the same account and message after an uncertain result.
An interrupted receipt requires manual follow-up.

## Browser fallback

When a page needs interaction, the tool starts **Finish email unsubscribe**
under the thread that requested it. The initial result is `in_progress` with
the child thread ID. BB notifies the parent when the child finishes or gets
stuck. Calling the tool again for the same message returns the recorded
outcome while the attempt is active or after it has settled.

The child uses BB Browser Automation in a fresh local headless session on
the parent thread's enrolled execution host. That host needs Chrome and the
built-in browser integration. The job ID in the child prompt expires after
ten minutes. Only the linked child can fetch the URL and verified receiving
address from the job. Those values can appear in the child’s tool history
or live preview. BB's normal browser permissions apply.

The child stops for sign-in, a CAPTCHA, or a change that could affect other
subscriptions. If the child exits without a result or BB reloads during the
attempt, the tool records an unverified outcome.

Provider messages and link tokens can contain personal data. Diagnostics
give fixed failure categories and omit URLs, response bodies, and account
details. Browser or form results describe the response received, and future
delivery can take time to change.
