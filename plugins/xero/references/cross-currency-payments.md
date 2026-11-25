# Cross-currency bill-payment handoff

This records a charge already paid outside Xero; it does not send money again.

Verify the bill, original document, existing payments, bank account, date, amount applied to the bill and bank withdrawal. Do not infer one amount from the other. Skip creating a payment if a matching one exists; match that existing payment instead. An already-reconciled payment needs no further action.

Fill every placeholder with verified values, including currency codes:

> **{supplier}, bill {number}: {bill_currency} {amount_applied}.**
> Already paid: {bank_account}, {payment_date}, withdrawal **{bank_currency} {bank_amount}**.
>
> 1. Open the bill's **Payments / Record payment** section.
> 2. Set **Payment amount: {bill_currency} {amount_applied}**.
> 3. Set **Paid from: {bank_account}**, date **{payment_date}**.
> 4. Set **Bank amount: {bank_currency} {bank_amount}**. Xero calculates the exchange rate from these two amounts. Equivalent FX fields must represent these same amounts.
> 5. **Record payment**, not online bill payment. Do not send money again.
> 6. In **{bank_account} → Reconcile**, find **{statement_date}, {bank_currency} {bank_amount}**. Use **Find & Match**, select that recorded payment, then **Reconcile**.

For a USD bill paid from a CAD account, explicitly write **Payment amount: USD …** and **Bank amount: CAD …**. Never put the CAD withdrawal in the USD payment-amount field. For partial payments, use only the amount applied for that line; for full settlement, verify the bill balance reaches zero. Final recording/reconciliation remains manual unless the specific preparation was separately authorized.

Sources: [record a supplier-bill payment](https://central.xero.com/0/article/Record-payment-of-a-bill-UK-US), [foreign-currency payment fields](https://central.xero.com/s/article/Record-payment-of-a-sales-invoice), [bank reconciliation](https://central.xero.com/0/article/Reconcile-your-bank-account).
