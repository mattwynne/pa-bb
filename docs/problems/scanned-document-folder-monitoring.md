# New scanned documents cannot trigger a processing workflow

Status: open capability gap.

## Problem

The owner wants to watch a Google Drive or iCloud folder for newly scanned documents, then process them without manually checking the folder or starting each conversation.

The Google Drive and iCloud plugins need to expose folder monitoring as an assistant-accessible capability. The user should be able to choose what happens when a document arrives: ask for a decision each time, or follow an explicitly configured processing workflow. Monitoring and processing are separate responsibilities; detecting a file must not itself authorize arbitrary actions on it.

The tools available in the reporting conversation did not expose persistent folder monitors. This is a requested capability, not evidence of a failed watch or a provider outage.

## Desired outcome

The user can ask, for example, “Watch this scans folder and ask me what to do with new documents.” They can subsequently configure a particular processing workflow without changing how the source folder is monitored.

- Select the provider, account and folder explicitly, with a clear choice between new arrivals only and including existing documents.
- Keep monitoring independently of an active agent turn, including recovery after plugin reloads or server restarts.
- Offer tools to create, inspect, pause, resume and remove monitors, with visible pending arrivals and failures.
- Present document details and user choices when configured to ask; dispatch only the selected or previously authorized workflow.
- Track arrival and processing state durably to avoid repeated processing. Surface uncertain outcomes rather than blindly replaying side effects.
- Preserve source documents by default. Moving, deleting, sharing or sending content requires the applicable authorization; setting up a monitor must not bypass existing approval policies.

## Questions for implementation

- How should Google Drive change tracking detect arrivals, including files moved into the watched folder, and reconcile after interruptions?
- Which iCloud folder types can the integration actually monitor? Do not assume the existing local-note capability provides arbitrary iCloud Drive document access.
- How can each provider establish that a document is available for reading rather than still uploading, downloading or syncing? A local file appearing is not sufficient proof of download completion.
- What defines a new document versus a revised, renamed or duplicate scan? Should subfolders be included?
- How should a monitor connect to a user-chosen workflow or decision prompt without keeping an agent tool call open indefinitely?
- What document download, PDF/image reading or OCR capabilities are needed for processing? Monitoring alone does not supply them.
- What limits, retry rules, retention and cancellation behavior keep unattended work bounded and recoverable?

Treat filenames and document contents as untrusted input, not workflow instructions. Report local availability and cloud sync facts separately; neither a successful sync timestamp nor a detected arrival proves delivery to another device.

This note records the problem only. No monitor was configured and no document was processed.
