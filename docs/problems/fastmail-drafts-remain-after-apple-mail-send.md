# Fastmail drafts remain after sending through Apple Mail

Status: open interoperability problem. An earlier PA workaround exists; BB does not expose its local draft-creation tool. The underlying provider/client mechanism remains unproven.

## Problem

The assistant creates a reply draft through Fastmail's official MCP server. The owner opens and sends it through Apple Mail, but Fastmail retains the original draft alongside the sent reply.

The leftover looks like unfinished work and makes it hard to trust Drafts. It also creates a risk of sending the same reply again. A draft and a sent copy are not evidence that two messages were sent.

## Current evidence

The originating BB installation retains investigation thread `thr_s6g2ynef6g` and corroborating thread `thr_82p69xcwud`. Their transcripts and investigation report contain private correspondence; do not copy that content into this repository.

- The investigation confirms a reply draft still marked as a draft alongside a corresponding sent message. Thread, sender, recipient, subject and normalized body agree.
- A separate conversation records the same coexistence after an MCP-created reply was sent through Apple Mail, using a different sending address.
- An earlier reported occurrence cannot be reconstructed because its original draft is no longer available.
- The assistant explicitly identifies the official MCP draft creator as the creation path.

Repository inspection supports that account: [`plugins/fastmail/server.ts`](../../plugins/fastmail/server.ts) registers provider-discovered tools and forwards their arguments to Fastmail. It adds local label and contact-group tools, but no equivalent of PA's local `fastmail_create_draft`. See the [Fastmail plugin README](../../plugins/fastmail/README.md) for the runtime tool-discovery contract.

These observations establish a recurring symptom, not whether a particular header, draft representation, IMAP mapping, sync race or server operation causes it. Existing synthetic MCP forwarding tests do not exercise Apple Mail's send-and-retire behavior.

## Earlier investigation and workaround

Holocron recovered the PA session **“Diagnose Mail Draft Duplication”**, `pi:01a0c1eb`, dated 2026-09-21 UTC. It records the same owner-reported symptom and a workflow change from CLI-created drafts to the hosted MCP creator.

That investigation led to two commits in the earlier PA repository:

- `739508f188d6d3223f0730ac0bd1fba3292d0db5`, **Restore Mail.app-compatible draft creation**: restore `fastmail-cli send --draft` / `reply --draft` and prohibit the MCP creator for normal drafts.
- `895488b77f5b96b8767ff551e5fe512beb6247c3`, **Add local Fastmail draft creation tool**: wrap the CLI path in `fastmail_create_draft`, supporting new/reply drafts and attachments, with readback that confirms draft status and no sending.

The earlier integration still documents this distinction and retains its implementation in `integrations/fastmail-email/draft-creation.ts`. The BB plugin currently uses the creation path that workaround replaced.

The historical session records implementation and passing automated tests. It does **not** establish the precise provider/client difference or contain a subsequent owner-confirmed Apple Mail round trip. Treat it as an existing implementation to evaluate, not a completed interoperability proof.

## Desired outcome

An assistant-created draft can be reviewed and sent through Apple Mail without leaving a stale original in Drafts. Preserve reply threading, sending identity, recipients, body and requested attachments. Creating a draft must never send it.

Evaluate reuse or adaptation of the earlier CLI-backed creation path before starting from generic Apple Mail troubleshooting. Do not assume the CLI, credentials or Pi extension are available in BB, or change account settings to make the symptom disappear.

## Verification and boundaries

- With explicit owner approval, compare disposable MCP-created and CLI-created drafts sent through Apple Mail. Record the exact draft IDs and inspect Sent and Drafts separately after sync.
- Require owner-confirmed sending and verified retirement of the original draft before declaring the interoperability problem resolved. Readback immediately after creation proves neither.
- Cover new messages and replies, and verify threading, identity and attachments for each supported case. Keep synthetic tests separate from live client verification.
- Keep private message content, raw headers and credentials out of public evidence and diagnostics.
- Never automatically delete a leftover draft, resend a message, or retry an uncertain mutation. Existing-draft cleanup requires a separate explicit request.

This note proposes investigation and a scoped creation-path change, not mailbox cleanup, deployment or release. No email or deployment mutations were made while gathering this evidence.
