# PA for BB: an assistant you can make your own

Your commitments and context are scattered across calendars, email, documents and notes. Bringing them together takes work before you can get on with the work itself.

PA for BB should help you prepare, plan and follow through. Ask what needs your attention, find the context behind a meeting, turn a conversation into a useful note, or draft the reply you have been putting off. Spend less time gathering information and more time deciding what to do with it.

We are building towards an **open-source, self-hostable personal assistant that works for you, on terms you control**. It lives in [BB](https://getbb.app), alongside the AI agents you already use, and connects to the services you choose. You should not have to move your life into a new system to get help with it.

## Start with what you need to do

“What do I need to prepare for tomorrow?” should be enough to begin.

PA should look across your connected calendars, find relevant documents and notes, and bring back a useful account of what is coming: the meeting that needs a decision, the document worth reading, the commitment you have not followed up. It should link to its sources and say what it could not check.

You can then ask it to help: draft an agenda, save a preparation note or write a reply for you to review. It should be clear what PA is suggesting, what it has done and what still needs your attention.

The same approach applies beyond meetings:

- **Get your bearings.** Bring together commitments and open tasks so you can decide where to focus.
- **Recover the context.** Find the email, document or note behind a question without remembering where you put it.
- **Follow through.** Turn decisions into notes, drafts and calendar changes rather than leaving them buried in a conversation.

These are outcomes, not promises to automate every part of your life. PA should help you exercise judgment, not quietly take it away.

## Keep your information where it belongs

Your calendar can stay in your calendar service. Your documents can stay in Drive. Your notes can remain Markdown files in an Obsidian vault. PA brings them into a conversation when they are useful; it should not require a new master copy of your life in a proprietary PA database.

Connect only what you need. A calendar alone should be enough for useful help with your schedule. Email, documents and notes can add context without becoming mandatory. Missing access or a failed connection should produce an honest, partial answer—not a confident claim that PA has checked everything.

You should be able to stop using PA without losing the work it helped you create. Removing a connection must not silently delete your information or break unrelated connections.

## Your assistant, under your control

Sovereignty means having practical choices, not just being told that you own your data.

- **Choose where it runs.** You should be able to host BB and PA on a computer or server you control, without depending on a PA-operated service.
- **Choose what it can access.** Connect your own accounts, understand the permissions you grant and withdraw access when you no longer want it.
- **Choose the AI you use.** PA should work with BB's supported AI providers rather than make one model company a requirement. Differences in provider capabilities should be made clear.
- **Inspect and change it.** The open-source goal is code you can study, run, modify and share under an explicit open-source license—not merely code you can view. You should be able to adapt the assistant or maintain your own version.

Self-hosting is not the same as keeping everything offline. Connected services still receive requests, and a hosted AI provider may receive information needed for the conversation. PA must make those boundaries understandable. It must not claim that information stays on your server when it does not.

Control also comes with responsibilities: running the host, protecting access and keeping backups. Setup and maintenance should be documented and repeatable, without pretending those responsibilities disappear.

## Help you can trust

Access is not an instruction. Connecting an account makes capabilities available; it does not give PA a standing invitation to send messages, reorganize files or change your plans.

PA should act on your requests, explain consequential changes and honor the confirmation steps required by BB and each integration. Not every edit needs another prompt, but you should understand what authority you have given it. It must distinguish a draft from a sent message, a local save from a completed sync, and an uncertain result from a confirmed change. If an action may already have succeeded, it should check rather than blindly repeat it.

Emails, documents and notes are information to consider, not instructions that can override your wishes. Credentials should stay out of conversations and logs. Your personal preferences and knowledge should remain yours to inspect and change, not become hidden rules you cannot correct.

The current scope is **one owner per BB installation**. PA must not suggest that a shared installation provides privacy between users when it cannot enforce that separation.

## Grow it at your pace

PA's BB marketplace lets you choose connections independently. Adding the marketplace should install nothing by itself. Install the integrations you want, connect your accounts and add others when they become useful.

Integrations provide access to services. Task-focused abilities bring those services together for work such as meeting preparation or weekly planning. That distinction should help us build a coherent assistant, not become something you must learn before using it.

PA should build on proven open-source tools and workflows, including those developed for Pi, without requiring you to understand their origins. Contributors should be able to improve a connection or add a useful ability without rebuilding the whole assistant. The aim is a shared foundation that people can adapt, not one person's private setup packaged as a universal solution.

## What success looks like

You open BB, ask for help preparing for tomorrow and get an answer that saves you real effort. You can see where it came from, correct it and choose what happens next.

You know where your assistant runs, what it can access and which services receive your information. You can change the code, change providers or walk away without abandoning your work.

That is the goal: **useful help with your life, without giving up control of it.**

This is the intended experience, not a claim that every part is delivered today. See the [README](../README.md) for available integrations and the [roadmap](roadmap.md) for the next steps.
