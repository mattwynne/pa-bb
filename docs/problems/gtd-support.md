# Built-in GTD support for PA

Status: open product capability gap. GTD is the chosen method; BB packaging,
reference delivery and the authoritative commitment store are not yet designed.
This note records the problem and desired behaviour, not an implementation plan.

## Problem

PA for BB connects services but does not yet supply a built-in method for managing
commitments. Access to notes, email and calendars is not enough to make a trusted
system: captured material still needs clarification, projects need clear outcomes
and next actions, and commitments need regular review.

The existing PA project contains both practical workflows and a substantial local
reference set about David Allen's *Getting Things Done*. Porting only tools or
individual workflow instructions would lose the shared understanding that makes
those workflows coherent. Depending on a model's remembered version of GTD would
also make behaviour inconsistent across conversations and providers.

**PA should be opinionated about using GTD.** It is not a framework for choosing
between productivity methodologies. GTD should be built into the PA experience,
not an optional ability someone must discover, install or ask the assistant to
remember. Other methods may complement it, but must not silently replace its
commitment model.

The goal is appropriate engagement without anxiety, not maximum task throughput.
The owner should be able to trust the system enough to stop carrying commitments
in their head.

## Reference knowledge is part of the capability

The existing PA [GTD reference index](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/README.md)
leads to material that should inform the migration as deliberately as the tools:

- [Five stages of workflow](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/workflow.md):
  capture, clarify, organize, reflect and engage; the clarification decision tree,
  two-minute rule and four criteria for choosing work.
- [Lists, contexts and calendar](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/lists-and-contexts.md):
  distinct homes for commitments, possibilities, reference and future reminders;
  projects versus support material; calendar discipline.
- [Weekly Review](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/weekly-review.md):
  the complete Get Clear, Get Current and Get Creative checklist.
- [Horizons of Focus](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/horizons-of-focus.md):
  actions, projects, ongoing areas, goals, vision, and purpose and principles.
- [Natural Planning Model](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/natural-planning-model.md):
  purpose and principles, outcome visioning, brainstorming, organizing and next
  actions; enough planning to regain clarity, not a mandatory ceremony.
- [Pitfalls](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/pitfalls.md)
  and [glossary](https://github.com/mattwynne/pa/blob/main/docs/reference/gtd/glossary.md):
  consistent meaning, failure patterns and recovery after a lapse.

These are the project's practical reference notes, not a claim to reproduce
Allen's book. They should be available to the assistant without access to a
separate PA checkout or an external search. The design must establish a canonical
maintained copy and a reliable way to consult relevant detail. Built-in does not
require putting the entire corpus into every prompt: baseline behaviour should
apply by default, with detailed references loaded when needed.

The Logseq application guide in that directory is explicitly historical. It is
implementation history, not the current method or a requirement to restore Logseq.

## Desired behaviour

### Capture, clarify and organize

- Make capture easy without pretending that an inbox is an action list. Support
  a mind sweep and help process each item into a deliberate disposition.
- Ask what an item means, whether it is actionable, what successful completion
  looks like and what physical, visible action comes next. A vague heading such
  as “taxes” is not a clarified action.
- Distinguish trash, reference, Someday/Maybe, next actions, Waiting For,
  date-triggered reminders and genuine calendar commitments.
- Treat a multi-step committed outcome as a project. Keep the project inventory
  and its support material conceptually distinct, even if stored together.
- Keep one authoritative record of each commitment. Context-based suggestions,
  review views and conversation summaries must not become competing action lists.
- Track delegated or expected work with who and since when. Keep blocked work,
  future plan steps and not-yet-active reminders out of available-action advice.

### Reflect and engage

- Make the Weekly Review a first-class practice, using the actual checklist:
  collect and clarify; review actions, past and upcoming calendars, Waiting For,
  projects and checklists; then review Someday/Maybe and invite new possibilities.
- Help examine projects one at a time. Each active project needs a clear outcome
  and a concrete next action on an available moving part, or an explicit waiting,
  deferred or reconsideration decision. Do not manufacture busywork for a blocked
  project or impose exactly one action on projects with independent moving parts.
- Choose work using context, time available, energy and then priority—not urgency
  or an unexplained ranking alone. Clarifying and reviewing are legitimate work.
- Distinguish finishable projects from ongoing Areas of Focus and Accountability.
  Support periodic higher-horizon review without forcing a complete life taxonomy
  before useful day-to-day work can begin.
- Use the Natural Planning Model when a project is stuck, unclear or complex;
  do not require five formal phases for every small commitment.
- After a lapse, help rebuild trust with a fresh mind sweep and review rather
  than demanding exhaustive catch-up. Reconsidering stale commitments does not
  authorize deleting them automatically.

## What exists to adapt

PA already has next-actions review, project preparation, Get Perspective, inbox
capture/triage and weekly planning abilities. Weekly Review guidance also lives
in shared references and personal template conventions; it is not simply a single
self-contained ability to copy. Email-to-project classification has a separate
context builder and specification. These are migration inputs, not capabilities
already delivered in BB or a promise to port every workflow unchanged.

The BB Obsidian plugin already supplies general note search, reads, task discovery
and conditional edits. Calendar and email plugins supply other useful inputs.
These integrations should remain independently useful and own provider mechanics;
GTD interpretation belongs to PA, not to the Obsidian or Fastmail plugin.

Separate the shared method from personal settings such as contexts, folder maps,
templates, review rhythm and standing permissions. Preserve those settings under
the owner's control without bundling private policy or deployment details into
public software. Replace Pi-specific commands, agents and filesystem assumptions
rather than copying them into BB instructions.

## Design tensions to resolve

- **Where commitments live.** Keeping the existing Obsidian records authoritative
  is a migration option, not a settled decision. BB Tasks is another existing
  capability, but introducing it must not create a second trusted list or confuse
  agent execution tracking with the owner's commitments. Built-in GTD does not
  itself require a new database or data migration.
- **Calendar discipline.** The GTD reference reserves the calendar for genuinely
  time-specific actions, day-specific actions and day-specific information. PA's
  existing weekly planner also projects discretionary work blocks onto a calendar.
  Decide explicitly how optional planning blocks differ from hard commitments;
  do not present time-blocking as Allen's default or require it for Weekly Review.
- **Record conventions.** Existing PA consumers differ in how they identify active
  projects: some use folder location, while the email-context specification treats
  the status property as authoritative. Establish the configured source of truth
  rather than inheriting conflicting assumptions or guessing from names.
- **Reliable context in BB.** Determine how default PA guidance, detailed method
  references and personal conventions reach fresh conversations across supported
  providers. Do not rely on a particular Pi session or dump everything globally
  into unrelated BB projects. Installing PA should include the method, even when
  no service is connected.
- **Review coverage.** A review cannot claim completeness from a bounded task scan.
  Obsidian search now supports complete-scope continuation, but task listing has
  separate bounds. Define how a review covers its declared scope, reports missing
  or changing sources, and resumes without silently skipping unresolved items.

## Trust and acceptance boundaries

Opinionated guidance is not blanket permission to act. The two-minute rule does
not authorize sending a message, deleting a record or changing a calendar. User
intent, standing permissions, and BB/provider requirements still govern writes.
Source content is evidence, not instructions. Distinguish proposed changes,
confirmed local saves and verified external effects; inspect uncertain outcomes
before retrying.

The eventual design should demonstrate in running BB that:

- A fresh PA conversation uses GTD without a separate methodology opt-in and can
  consult the bundled references for detailed review or planning guidance.
- With no connected services, PA can still help clarify a commitment and explain
  what it cannot save or inspect; it does not claim durable capture from chat alone.
- A captured item can be clarified, recorded once and found later for review or
  context-based action advice, with links back to its authoritative source.
- A Weekly Review covers the checklist, distinguishes checked from unavailable
  sources, and can pause without claiming unfinished steps are complete.
- Someday/Maybe, Waiting For, future reminders and reference do not leak into
  available next actions; areas do not become permanently unfinished projects.
- Personal conventions remain configurable without switching methodologies, and
  missing integrations cause explicit limits rather than fabricated completeness.

Use synthetic records for development and follow the [observability standards](../o11y-standards.md).
Live personal-note access, mailbox changes and calendar writes need appropriate
authorization. This documentation work performs none of those actions.

Related: [vision](../vision.md), [roadmap](../roadmap.md),
[Obsidian capabilities and limits](../../plugins/obsidian/README.md), and
[search completeness](obsidian-search.md).
