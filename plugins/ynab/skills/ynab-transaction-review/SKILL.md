---
name: ynab-transaction-review
description: Review YNAB's transaction queue after a bank import, categorize expenses, or clear items awaiting approval. Use when the user asks to review or approve transactions, including ones that already have categories.
---

# Review YNAB transactions

Use the connected YNAB plan and its approved transaction history. Receipts, statements, earlier conversation decisions, and private notes can help when available. The workflow also works with YNAB alone.

## Scope the review

- Discover tool names and schemas with `ynab_list_tools` and call them with `ynab_call_tool`. Resolve the intended plan and use its exact ID for reads and writes. Ask which plan only when the request and available context leave a material ambiguity.
- For a request to clear the review queue, inventory both unapproved and uncategorized transactions. Unapproved entries may already have categories, and uncategorized expenses may already be approved. If the user specifies an account or time range, keep that scope. Compare returned counts with the available total and split large reads by account or date before claiming full coverage.
- Use the account's budget status and transfer linkage to identify entries that need a category. A linked transfer between budget accounts can be ready for approval without a category. Transfers involving an off-budget account can require a category on the budget side. Tracking entries, loan adjustments, and starting balances can legitimately show as uncategorized.
- A request to clear or approve the queue authorizes category fixes and approval of verified entries in scope. For a review-only request or a read-only connection, provide findings and proposed categories. Treat changes to clearing or reconciliation status, amounts, dates, transfer links, schedules, and budget assignments as separate work.

## Decide from evidence

- Use the user's explicit instructions and applicable prior decisions first. Check approved history for the same payee, purpose, and direction. Account, amount, and recurrence can corroborate the match. A single exact precedent can support a routine, low-ambiguity purchase. Mixed categories, broad merchant descriptions, or changed amounts or purpose call for more evidence.
- Keep routine categories with clear evidence and correct those contradicted by the evidence. Search narrowly for receipts, statements, or private guidance only when connected and relevant. A processor or generic transfer label may conceal the underlying purpose. For example, a receipt that shows a subscription and its separately posted tax supports categorizing both components together.
- Use known recurring patterns for the same account, recipient, direction, and purpose. Equal amounts alone do not identify a transaction or prove a duplicate. Inflows may be refunds, reimbursements, or transfers rather than new income. If a possible duplicate, bad match, or transfer is still unresolved, hold it for the user's decision.
- Ask only about unresolved entries. Group them with date, payee or description, amount, and the smallest question needed. If the user confirms a recurring rule, apply it to the matching items in the current review. Keep any saved preferences private and use a destination the user has authorized.

## Apply and verify

1. Resolve categories to exact IDs from the selected plan. Before writing, confirm each target still matches the reviewed transaction and its category or approval state. Use verified category updates when supported, or update only the category field. Verify each category change before approving it.
2. Use bulk approval when available for the reviewed IDs, including verified entries whose existing category is correct and linked in-budget transfers that need approval. Approval and clearing are independent. Leave clearing status as recorded. If a write is uncertain, reread before retrying.
3. Reread the in-scope unapproved and uncategorized queues after the last batch, including after any user replies. Report what was approved or categorized and the remaining counts. Claim the queue is clear only after confirming zero unapproved entries and zero uncategorized entries that need a budget category. If the user must decide a few cases, finish the supported entries first and report what is still waiting.
