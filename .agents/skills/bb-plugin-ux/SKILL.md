---
name: bb-plugin-ux
description: Plan, implement, or review settings, onboarding, connection, error, or approval UI for PA for BB plugins. Use for any plugin UI change in this repository.
---

# BB plugin UX

1. Read `../../../docs/ux-standards.md` in full (relative to this skill directory) before planning or editing UI. Treat its definition of done as the acceptance criteria, not an optional style guide.
2. Inspect BB's actual host page and a comparable existing plugin before choosing headings, controls, spacing, or tokens. Design first-run, pending, connected, empty, error/recovery, and approval states where applicable. Do not invent account identity or granted access from a connection flag or tool count; show only verified information.
3. Make setup self-contained: ordered steps, provider-versus-BB actions, a complete guide, and exact copyable values when required. Keep setup out of the connected view except behind a quiet guide or disclosure. Never ask users to send OAuth callbacks or credentials to chat or logs.
4. Use BB theme tokens, responsive layout, visible keyboard focus, labels, and accessible status/error messages. Remove headings or instructions the BB host already supplies. Explain destructive actions and distinguish completed changes from proposals or failures. Follow the project's consent policy; do not invent an extra approval gate merely for the sake of this checklist.
5. Exercise relevant states in a running BB instance, including narrow viewport and keyboard navigation. Test connection and failure paths without exposing real credentials or making unapproved provider writes. Automated component and host tests help but do not replace rendered review. If live review is blocked, report the UX gate as **unverified**, with the exact states still to check; do not claim the UI is done.
