# Fastmail contact-group membership

## Decision

Extend the existing `plugins/fastmail` package. Copy the conservative CardDAV service and tests from `mattwynne/pi-extensions` at `1bbb7ccb48a11462197457b890cab8ef71178082` with MIT attribution. Maintain the copy locally; do not extract a shared package, depend on Pi, add another Fastmail plugin or recreate the official MCP catalog.

Incoming-message labels and contact groups are separate. Rules based on groups need contact membership changes to affect future mail. Historical message moves are not evidence of contact updates or authorization to make them.

## This increment

- Copy the existing TypeScript CardDAV service and its 35 synthetic service/transport tests.
- Replace environment credential lookup with explicit, server-side BB secret settings; no account fallback.
- Add a native `fastmail_contact_groups` tool for list/get/add/remove, with preview default, strict arguments and conditional selection when configured.
- Retain exact resolution, ambiguity/cross-book rejection, whole-contact scope warnings, fresh strong-ETag conditional writes, unrelated-byte preservation, read-back verification and no automatic write retries.
- Add fixed safe error categories, bounded tool output and BB host tests covering actual built registration, settings lifecycle, mutation verification, conflict, uncertain outcomes and privacy.
- Document the existing official-MCP search/create workflow and explicit destination-first/non-atomic move workflow. Do not silently create contacts or remove other groups.

## Deliberate exclusions

No CardDAV contact/group creation, automatic duplicate merging, full member roster browser, automatic move/batch transaction, rule editing, shared package or durable operation ledger. The copied service lists the first 50 groups with an explicit total/truncation marker; exact names/UIDs remain usable for get. Uncertain-write recovery requires a fresh read or inspection in Fastmail, not replay. Durable receipts/pagination can be follow-up work if demonstrated necessary.

The optional JMAP mail token does not establish a supported Contacts API or CardDAV access. Public Contacts capabilities must be verified before replacing this path; do not use undocumented Fastmail web methods.

## Gates and limits

Run package build, tests and typecheck with synthetic transports; verify privacy with sentinel credentials and provider bodies. Test the BB adapter, not just direct service functions. Retain public SDK imports and inspect the deployed configuration without entering credentials during UI review. An optional live read needs securely configured credentials; no live contact mutation is necessary for delivery. Membership verification does not establish downstream mail-rule behavior.

## Verification

- Fastmail 0.1.7: 111 Node tests plus three Cucumber scenarios / 18 steps passed; build, typecheck and shared connection-UI drift checks passed.
- The SDK dev pin was refreshed to the actual host's 0.6.37 declarations. No new BB SDK surface was introduced.
- A disposable BB 0.46.0 local-path installation loaded the plugin and returned honest disconnected status without credentials.
- Ten rendered combinations (1280/390px × unconfigured, connected, unavailable default sender, pending and status error) passed with synthetic status replies, keyboard traversal, masked fields and no horizontal overflow. The MCP disconnect warning now explicitly retains CardDAV as well as JMAP credentials. No consent flow or provider mutation was exercised.
- Live CardDAV compatibility, actual account equivalence and future-message routing remain unverified. Production delivery is recorded separately when observed. No live sender examples or private deployment details belong in this public document.
