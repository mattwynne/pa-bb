Drafted by Matt's robot

# Google Drive files cannot become email attachments

Status: open capability gap. Reported 2026-10-10; observed in BB on 2026-10-08.

## Problem

Email files found in Google Drive as actual attachments, rather than Drive links. The assistant can find the files but cannot retrieve their bytes through the Google Drive plugin. Asking the owner to download and upload them manually defeats the workflow.

## Evidence

The production PA BB server (`pa`, LXC 120 on `hub.local`) retains Pi thread `thr_fmk9kheeiw`. Read its events with `bb thread log thr_fmk9kheeiw --json --all` on that host; the transcript contains private material and must not be copied into this repository.

- Earlier events show Drive account discovery, file searches, and folder browsing.
- Event **98**, 2026-10-08 **00:58:48 UTC**: the owner requests an email with the original files rather than links.
- Event **102**: the assistant inspects Fastmail's tool catalog.
- Event **113**, **00:58:55 UTC**: the assistant reports that Drive does not expose file downloads and offers to prepare an attachment draft if the owner uploads the nine files manually. It also reports that Fastmail can draft but not send.
- Event **116**: the owner accepts a draft containing links instead.
- Events **119–120**, **01:00:33 UTC**: `fastmail_draft_email_c6d5bc9c` completes with Drive links in the body and no attachment argument.

Repository evidence agrees with the download limitation:

- [`plugins/google-drive/server.ts`](../../plugins/google-drive/server.ts) registers account status, search, folder listing, metadata/link retrieval, and Google Docs plain-text reading only.
- [`plugins/google-drive/adapters/google.mjs`](../../plugins/google-drive/adapters/google.mjs) retrieves file metadata and Docs JSON, not file bytes or exported documents.
- The [plugin README](../../plugins/google-drive/README.md) describes this limited read-only tool set.

This is a missing capability, not evidence of a failed download request or expired authorization. Read-only access and downloading are not inherently contradictory. `gdocs_read` is not a substitute for retrieving an original attachment.

## Desired outcome

The assistant can retrieve selected Drive files and pass them to an email attachment workflow without a manual download/upload round trip. Preserve filenames and media types, select the source account explicitly, and explain unsupported formats, permission restrictions, or size limits rather than silently substituting links.

## Questions for implementation

- How should retrieved bytes reach Fastmail's attachment upload tool safely, without putting binary content or credentials into agent context or logs?
- Which file types and sizes should be supported first? Google-native documents need an explicit export format rather than a promise to download an “original” binary.
- What temporary storage and cleanup are needed?

Verify the workflow separately from sending permission. The thread's Fastmail send limitation is a second boundary; adding Drive downloads alone would not enable sending. Preparing attachments must not imply permission to send an email.

No plugin changes or live email mutations were made during this investigation. Recipient details, filenames, file IDs, message bodies, and grants are deliberately omitted.
