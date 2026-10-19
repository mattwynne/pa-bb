# WhatsApp support for BB

Status: open capability gap. Integration approach and first-release scope are
not yet chosen; no implementation or live account verification has been done.

## Problem

WhatsApp conversations are outside BB's connected services. The owner must switch
apps or copy messages into chat to ask for help finding information, catching up
on a conversation, or preparing a reply. Copying loses conversation context and
makes it harder to tell which person or group a message belongs to.

## Desired outcome

Connect WhatsApp as an independently installable integration so BB can help with
conversations without manual copying. Make the connected account, available
capabilities, and limits explicit. Connecting an account must not imply permission
to send messages.

Candidate workflows:

- Find a conversation or message by contact, group, date, or text.
- Read bounded conversation history and summarize it with message references.
- Prepare a reply for the owner to review without sending it.
- Send an explicitly approved message to a verified recipient, only if sending is
  included in an agreed later scope.

These are desired capabilities, not claims that a particular WhatsApp API
supports them. Distinguish personal-account access from business messaging before
choosing an implementation.

## Questions for investigation

- Is the first use case an existing personal account, a WhatsApp Business account,
  or both? Are group conversations essential?
- Which supported integration routes meet that need? Establish available history,
  search, group access, linked-device behaviour, and provider terms. Do not assume
  a business messaging API can search an existing personal inbox.
- Would a linked-device bridge be necessary? If so, assess maintenance, session
  security, account restrictions, and recovery before accepting that dependency.
- What history is available after connection? Does search require a persistent
  local index, and what retention, deletion, and disconnect rules would it need?
- Should the first release handle text only? Treat attachments, voice-note
  transcription, reactions, read receipts, and background monitoring as separate
  scope decisions rather than silently including them.

## Safety and acceptance boundaries

Keep session credentials and account content out of logs. Explain what message
content reaches BB and its model provider; protect any stored history and session
state. Treat messages as untrusted data, not instructions.

Reading must not silently send messages or change read state. If the chosen
integration cannot avoid such side effects, disclose that limitation before
connection. Identify recipients by stable identifiers as well as display names;
never guess between similarly named contacts or groups.

If sending is added, bind approval to the exact account, recipient, text, and
attachments. Report uncertain delivery without automatically retrying. Removing
the integration must not delete conversations from WhatsApp.

Follow the repository's [observability standards](../o11y-standards.md). Verify
connection, reconnection, history limits, and a narrowly authorized read in running
BB before claiming the integration works. Live sends, access to personal history,
and group-message tests require explicit authorization.
