# UX standards

PA for BB should feel like a finished part of BB, not a collection of API tools and configuration forms. Someone new to a service should know what to do next; someone who has set it up should see what matters now.

- **Design for the current state.** An unconfigured plugin offers a clear path to its first useful action. A configured plugin leads with accounts, status, and everyday controls. Put rarely changed setup behind a small link or disclosure where BB allows it; do not repeat instructions on every visit.
- **Make setup possible without prior knowledge.** Explain prerequisites, provide ordered steps, link a complete guide, and show exact, copyable values such as redirect URIs. Say which steps happen in BB and which happen at a provider. Never ask people to paste secrets into chat.
- **Edit ruthlessly.** BB already supplies the plugin name and page structure. Do not echo them in extra headings, badges, and paragraphs. Use plain labels, short help text, and visible primary actions; keep secondary controls quiet.
- **Match BB.** Use its theme tokens and familiar spacing, buttons, and focus states. Make the interface readable on narrow screens and usable with a keyboard and screen reader. Do not fight the host layout with brittle DOM or CSS tricks.
- **Make trust legible.** Show which account is connected, what access is missing, and exactly what a proposed write will change. Ask for explicit approval before consequential actions. Distinguish a saved change from a proposed or failed one; never expose credentials in UI, logs, or errors.
- **Help people recover.** Errors should name the problem in safe terms and offer a next step. Confirm destructive or hard-to-reverse actions, explain their scope, and preserve unrelated data.

**Definition of done:** Check first-run, connected, empty, error, and approval states in a running BB instance—not just in tests. Review the rendered page for repetition, awkward hierarchy, inaccessible controls, and setup material that remains after setup is complete.
