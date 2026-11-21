# GTD project listing — first read-only slice

## Decision

Keep GTD independent of its storage. A project has a source-scoped opaque ID, title and normalized status. A `ProjectBackend` reads a bounded inventory and checks current access. GTD core owns filtering, counts, ordering, continuation and output limits. Backend-specific metadata conventions belong only in the adapter.

Start with an Obsidian adapter for one explicitly configured connected vault and Projects folder. Use `type: project`, `status` and optional `title` frontmatter. Support the documented narrow status-only legacy layout without rewriting notes; status, not folder location, is authoritative. Treat project and source metadata as untrusted data. Do not conflate GTD projects with BB coding projects.

Obsidian exposes a generic, cancellable `listProperties` projection over its existing scoped search engine. It returns only selected properties and paths, never bodies or edit proofs. This avoids an agent-driven whole-vault discovery/search/read loop while retaining authoritative logical source access. It does not introduce another note store or a persistent index.

## Delivered surfaces

- `gtd_list_projects`, `bb gtd projects`, and `listProjects` RPC share core logic.
- `bb gtd sources` lists connected Obsidian source IDs for setup.
- Native BB settings choose backend, vault ID and relative Projects folder.
- All statuses by default; filters for active, deferred, someday and done. `completed` normalizes to done.
- Confirmed totals only after full, omission-free traversal. Partial inventories have null totals. Transport/access failures are errors, not empty success.
- Bounded server-side producer draining and single-use consumer pagination, with settings/access rechecks and disposal cleanup.

See the [plugin guide](../../plugins/gtd/README.md) for the complete schema, limits, setup and examples. The package remains an experimental source installation, not a marketplace release. The Obsidian consumer contract requires SDK 0.6.132; its SDK declarations and Zod dependency were aligned together to avoid incompatible duplicate Zod types.

## Verification

- GTD unit/host tests: backend-independent fixtures, classification and confinement, output bounds, duplicate identities/titles, pagination, stalled producers, cancellation, access/configuration changes, empty/partial/error outcomes, CLI/tool/RPC parity and diagnostic redaction.
- Obsidian suite: existing behavior plus compact properties RPC, long-body/small-frontmatter projection, no body leakage or edit proofs, exact folder scope, malformed YAML, cursor cleanup/revocation and safe failure diagnostics.
- Both packages typechecked against the running SDK and built through BB.
- Running BB: fresh GTD source installation, native first-run/configured settings, source discovery, complete and active-only inventories, empty-folder and unavailable-source outcomes, and pagination. A successful read confirms local source access only, not cloud or device delivery.
- Rendered review: compared native settings with another installed plugin at desktop width; checked GTD at a narrow viewport, keyboard focus/Tab behavior, validation alert, rejected parent-directory input and recovery to the saved valid configuration. No custom frontend or write-approval surface exists in this slice.
- File-writing integration application uses supported Pause/drain and restores only prior enablement; failed and already-paused sources remain untouched. No account content, screenshots, private source IDs or deployment configuration are committed as verification evidence.

## Not included

Project creation/editing, actions and contexts, reviews, arbitrary field/status mapping, multiple configured GTD sources, another production backend, a project browsing UI, persistent indexing, marketplace publication, or a versioned distribution release. A second production adapter can implement the same port without changing GTD core.
