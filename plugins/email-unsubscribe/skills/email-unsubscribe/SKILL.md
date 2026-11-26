---
name: email-unsubscribe
description: Unsubscribe from the mailing list linked to one exact Gmail or Fastmail email at the user's request.
---

Call `email_unsubscribe` with `provider`, `account`, and the exact provider message `emailId`. For Gmail select the connected email address. For Fastmail use the authenticated JMAP account ID or login address. An MCP sending alias does not identify the JMAP account.

Report the returned method and outcome. `confirmed` requires an acknowledgment, and `request_sent` means the endpoint accepted RFC 8058 or the mailbox accepted a mail request. Use the original message's provider link for manual follow-up if needed. An `unverified` result can mean the request took effect. Do not retry it automatically. If `draftMayRemain` is true, the Fastmail Drafts folder may contain the request. Follow separate workflow instructions when triaging Screener.
