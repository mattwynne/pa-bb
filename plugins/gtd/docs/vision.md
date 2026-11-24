# GTD for BB

GTD should help people trust their commitments enough to stop carrying them in their heads. BB already gives people a place to think through their work in conversations. GTD connects those conversations to the personal Areas and projects that give the work context. An Area is an ongoing responsibility. A project is a finishable outcome that takes more than one action. [GTD fundamentals](https://gettingthingsdone.com/what-is-gtd/) · [David Allen on project lists](https://gettingthingsdone.com/2011/05/where-is-your-projects-list/)

## Start with Areas, projects, and threads

The first interface should make it easy to find a project and get back to a conversation about it. Use BB's pane, navigation, and thread rows.

- **Areas** at `/plugins/gtd/areas` lists the Areas. Each Area has a link to its own page and stays visible when it has no projects.
- **An Area page** lists its projects. Wide panes show Area links and narrow panes use the native Area picker. The project filter starts on **Active**, offers **Someday**, **Done**, and **All**, and keeps its selection when switching Areas. **All** includes deferred projects.
- **A project page** shows the project title and its linked BB threads. The filter uses BB's separate **Active** and **Archived** checks. Active is selected initially. Either or both groups can be shown. The breadcrumb leads back to the Area, and each row opens the original BB thread.

Use links for Area and project pages so they can be bookmarked and support browser history. Resolve them through the inventory's existing source and record identity. The [stable identity plan](../../../docs/plans/029-stable-gtd-identities.md) covers durable identity across vault moves. Keep partial inventory and unavailable records visible as such. The [plugin README](../README.md) documents the current Obsidian conventions, project changes, and thread associations.

## What the research suggests

| Pattern | What it could mean in BB |
| --- | --- |
| **Quick capture followed by a filing decision.** OmniFocus and Things support recording a short item with optional context. Things holds raw items in an Inbox for later processing. [OmniFocus capture](https://support.omnigroup.com/documentation/omnifocus/universal/4.10.1/en/capture/) · [Things Inbox](https://culturedcode.com/things/support/articles/4001304/#inbox) | Capture a thought or a BB message with a source link. During clarification, show where the item will go and preserve the link when it is filed. |
| **A cross-project view of available work.** Todoist's GTD guide uses filters over tasks in their projects. Nirvana has dedicated lists and filters by context, time, and energy. [Todoist GTD guide](https://www.todoist.com/productivity-methods/getting-things-done) · [Nirvana quick guide](https://www.nirvanahq.com/help/quick-guide) | Surface the same action in its project and in Next Actions. Use context, time, and energy to narrow the list, then let the user choose by priority. |
| **Projects and Areas supply different context.** Things uses Areas to group commitments by responsibility. OmniFocus distinguishes parallel and sequential actions. Nirvana can attach a person to a Waiting For item. [Things Areas](https://culturedcode.com/things/support/articles/6378414/) · [OmniFocus project types](https://support.omnigroup.com/documentation/omnifocus/universal/4.10.1/en/perspectives/#project-type) · [Nirvana Waiting For contacts](https://www.nirvanahq.com/help/how-to/contacts) | Show the project's outcome, each action that can move it forward, and who has the next move when work is waiting. Keep the note and conversation available as support. |
| **Dates and reviews have distinct jobs.** OmniFocus Forecast brings dated work and calendar events together, and its Review advances one project at a time. Todoist offers a recurring Weekly Review checklist. [OmniFocus Forecast and Review](https://support.omnigroup.com/documentation/omnifocus/universal/4.10.1/en/perspectives/) · [Todoist Weekly Review](https://www.todoist.com/templates/gtd-weekly-review) | Label appointments, deadlines, and reminders by meaning. Give users an explicit way to confirm each review check and resume with unfinished checks visible. |

## Directions explored

- **Next Actions first.** Open on available work and filter by the user's circumstances. This speeds up choosing an action. The project link supplies the outcome and context when needed.
- **Projects and Areas first.** Open on outcomes, supporting material, and linked conversations. This builds directly on the existing inventory. Choosing across projects would take a separate action view.
- **Weekly Review first.** Open on a guided, resumable review. This helps the user restore trust after a lapse. It depends on a clear record of which sources and checks the review actually covered.

The approved first interface takes the navigation from **Projects and Areas first**. Capture, action selection, and guided review can be evaluated separately as the need for them becomes clearer.

## Principles for later work

Use one authoritative record for each commitment. Obsidian supplies the current Area and project records. Future action records need an explicit storage convention so that project pages, action views, and review can refer to the same record. Keep raw captures, available actions, Waiting For, Someday/Maybe, reference, and dated reminders distinct. An appointment belongs on the calendar. A blocked step becomes available when its prerequisite is met. [Choosing what to do](https://gettingthingsdone.com/2023/01/choosing-what-to-do/)

A Weekly Review should cover Get Clear, Get Current, and Get Creative. A paused or partial review should show what's left, including checks whose sources are unavailable. A proposed edit, a verified local save, and verified delivery are different states. Existing service permissions and user intent govern writes. [GTD Weekly Review](https://gettingthingsdone.com/2011/11/gtd-best-practices-review-part-4-of-5/) · [Broader PA GTD requirements](../../../docs/problems/gtd-support.md)
