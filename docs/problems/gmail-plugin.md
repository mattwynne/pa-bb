# Gmail support for BB

Status: open capability gap; scope not yet agreed.

## Problem

BB has no Gmail plugin. People using Gmail cannot ask BB to work with their
mail through this marketplace. Fastmail support does not provide Gmail access,
and the Google Calendar and Drive plugins do not provide mail access.

The [roadmap](../roadmap.md) allows for Gmail as a separate provider plugin.

## Desired outcome

Connect a Gmail account so BB can help with email without switching to a
browser or copying messages into chat. Keep account selection explicit and
credentials out of agent context and logs.

Reading mail, preparing drafts, and sending mail are separate capabilities.
Connecting an account must not imply permission to send messages.

## Questions for implementation

- Which workflow should come first: searching and reading mail, preparing
  replies, or sending approved drafts?
- Are multiple Gmail or Google Workspace accounts needed from the outset?
- Which labels, thread operations, and attachment workflows are essential?
- What OAuth scopes and Google verification requirements apply to the chosen
  scope, and can existing Google connection infrastructure be reused safely?

No Gmail implementation or live account access is included in this problem
record.
