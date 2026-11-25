import { z } from 'zod';
import { XeroError } from './diagnostic.ts';
import { providerFetch, responseJson, type Connection } from './connection.ts';

export const id = z.uuid();
export const querySchema = z.record(z.string().min(1).max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean()]));
export const lineItem = z.object({ Description: z.string().max(4000).optional(), Quantity: z.number().finite().optional(), UnitAmount: z.number().finite().optional(),
  AccountCode: z.string().max(50).optional(), TaxType: z.string().max(100).optional(), TaxAmount: z.number().finite().optional(),
  LineItemID: id.optional(), ItemCode: z.string().max(50).optional(), DiscountRate: z.number().finite().optional(),
  Tracking: z.array(z.object({ TrackingCategoryID: id, TrackingOptionID: id })).max(2).optional(),
}).strict();
const date = z.iso.date();
export const invoiceFields = z.object({
  Type: z.enum(['ACCREC', 'ACCPAY']).optional(), Contact: z.object({ ContactID: id }).strict().optional(),
  LineItems: z.array(lineItem).min(1).max(100).optional(),
  Date: date.optional(), DueDate: date.optional(), Reference: z.string().max(2000).optional(), InvoiceNumber: z.string().min(1).max(255).optional(),
  Status: z.enum(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'DELETED', 'VOIDED']).optional(),
  CurrencyCode: z.string().regex(/^[A-Z]{3}$/).optional(), CurrencyRate: z.number().positive().finite().optional(),
  LineAmountTypes: z.enum(['Exclusive', 'Inclusive', 'NoTax']).optional(),
}).strict();
export type InvoiceFields = z.infer<typeof invoiceFields>;
const record = z.record(z.string(), z.unknown());
const invoiceResponse = z.object({ Invoices: z.array(record).min(1) });
function fail(message: string): never { throw new XeroError('input', 'accounting_validation', message); }
function singleton(payload: unknown) {
  const parsed = invoiceResponse.safeParse(payload);
  if (!parsed.success || parsed.data.Invoices.length !== 1) throw new XeroError('response_invalid', 'invoice_read', 'Xero did not return exactly one invoice. No further change was attempted.');
  return parsed.data.Invoices[0]!;
}
function paymentDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value); if (iso) return iso[1]!;
  const legacy = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!legacy) return null;
  const date = new Date(Number(legacy[1])); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
const readPaths = /^\/(?:Invoices(?:\/[a-f\d-]{36}(?:\/(?:History|Attachments))?)?|Contacts(?:\/[a-f\d-]{36})?|Accounts(?:\/[a-f\d-]{36})?|Payments(?:\/[a-f\d-]{36})?|BankTransactions(?:\/[a-f\d-]{36})?|Reports\/(?:BankSummary|TrialBalance|ProfitAndLoss|BalanceSheet)|Organisation|TaxRates|Currencies|TrackingCategories|Items)$/i;

export function createAccounting({ connection, fetcher = fetch, signal }: { connection: Connection; fetcher?: typeof fetch; signal: AbortSignal }) {
  async function request(tenantId: string, path: string, method = 'GET', body?: unknown, query: z.infer<typeof querySchema> = {}, callerSignal?: AbortSignal, key?: string, contentType = 'application/json') {
    id.parse(tenantId);
    const auth = await connection.authorize(tenantId);
    const url = new URL(`https://api.xero.com/api.xro/2.0${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const mutation = method !== 'GET';
    auth.ensure();
    const response = await providerFetch(fetcher, url, { method, signal: AbortSignal.any([signal, callerSignal ?? signal]),
      headers: { Authorization: `Bearer ${auth.token}`, 'xero-tenant-id': tenantId, Accept: 'application/json', 'Content-Type': contentType, ...(key ? { 'Idempotency-Key': key } : {}) },
      body: mutation ? contentType === 'application/json' ? JSON.stringify(body) : body as BodyInit : undefined,
    }, mutation ? 'accounting_write' : 'accounting_read', mutation);
    const payload = await responseJson(response, mutation ? 'accounting_write' : 'accounting_read'); auth.ensure();
    // Xero can report validation failures inside HTTP 200 responses. Never claim these writes succeeded.
    const rejected = (value: unknown): boolean => Boolean(value && typeof value === 'object' && (
      ('HasErrors' in value && value.HasErrors === true) || ('ValidationErrors' in value && Array.isArray(value.ValidationErrors) && value.ValidationErrors.length) ||
      Object.values(value).some(v => Array.isArray(v) && v.some(rejected))));
    if (rejected(payload)) throw new XeroError('provider_result', 'accounting_result', 'Xero reported validation errors. No successful change is confirmed. Read the record and check its fields before retrying.');
    return payload;
  }
  async function readInvoice(tenantId: string, invoiceId: string, callerSignal?: AbortSignal) {
    id.parse(invoiceId); const value = singleton(await request(tenantId, `/Invoices/${invoiceId}`, 'GET', undefined, {}, callerSignal));
    if (value.InvoiceID !== invoiceId) throw new XeroError('response_invalid', 'invoice_read', 'Xero returned a different invoice. No further change was attempted.');
    return value;
  }
  async function verify(tenantId: string, invoiceId: string, callerSignal?: AbortSignal) {
    try { return await readInvoice(tenantId, invoiceId, callerSignal); }
    catch { throw new XeroError('verification', 'invoice_verification', 'Xero accepted the write, but the follow-up read failed. The change may already be saved. Inspect the invoice before retrying.', true); }
  }
  return {
    async read(tenantId: string, path: string, query: z.infer<typeof querySchema> = {}, callerSignal?: AbortSignal) {
      if (!readPaths.test(path) || path.includes('..')) fail('Use a supported Accounting API path, not a URL, query string or bank-feed endpoint.');
      querySchema.parse(query); return request(tenantId, path, 'GET', undefined, query, callerSignal);
    },
    readInvoice,
    async createInvoice(tenantId: string, fields: InvoiceFields, key: string, callerSignal?: AbortSignal) {
      const parsed = invoiceFields.parse(fields);
      if (!parsed.Type || !parsed.Contact || !parsed.LineItems || !parsed.CurrencyCode || !parsed.Date) fail('Specify Type, existing ContactID, LineItems, CurrencyCode and Date. Verify the source and search for duplicates first.');
      if (parsed.Status && parsed.Status !== 'DRAFT') fail('Create invoices and bills as DRAFT. Review currency, exchange rate, tax and totals before requesting approval.');
      const created = singleton(await request(tenantId, '/Invoices', 'POST', { Invoices: [{ ...parsed, Status: 'DRAFT' }] }, {}, callerSignal, key));
      const invoiceId = id.safeParse(created.InvoiceID);
      if (!invoiceId.success) throw new XeroError('verification', 'invoice_verification', 'Xero may have created the draft, but returned no usable ID. Search for it before trying again.', true);
      return verify(tenantId, invoiceId.data, callerSignal);
    },
    async updateInvoice(tenantId: string, invoiceId: string, fields: InvoiceFields, key: string, callerSignal?: AbortSignal) {
      const patch = invoiceFields.parse(fields);
      if (!Object.keys(patch).length) fail('Provide at least one invoice field to change.');
      const before = await readInvoice(tenantId, invoiceId, callerSignal);
      if (patch.Type && patch.Type !== before.Type) fail('Changing between a supplier bill and a sales invoice is not supported.');
      const currencyChanged = patch.CurrencyCode !== undefined && patch.CurrencyCode !== before.CurrencyCode;
      if (currencyChanged && (before.Status !== 'DRAFT' || (patch.Status && patch.Status !== 'DRAFT'))) fail('Change currency only while the invoice remains DRAFT. Review the new exchange rate before approving separately.');
      if (!currencyChanged && patch.CurrencyRate === undefined) {
        if (typeof before.CurrencyRate !== 'number' || !Number.isFinite(before.CurrencyRate) || before.CurrencyRate <= 0) fail('The current exchange rate could not be verified. No change was attempted.');
        patch.CurrencyRate = before.CurrencyRate;
      }
      if (currencyChanged && patch.CurrencyRate !== undefined) fail('Do not carry an old rate across a currency change. Omit CurrencyRate, keep DRAFT and inspect the newly calculated rate.');
      await request(tenantId, `/Invoices/${invoiceId}`, 'POST', { Invoices: [{ ...patch, InvoiceID: invoiceId }] }, {}, callerSignal, key);
      const after = await verify(tenantId, invoiceId, callerSignal);
      const invariantFields = ['CurrencyCode', 'CurrencyRate', 'Date', 'DueDate', 'Total', 'AmountDue', 'AmountPaid', 'Status'];
      const referenceOnly = Object.keys(fields).every(k => k === 'Reference');
      const invariantsChanged = referenceOnly && invariantFields.some(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      const mismatched = (patch.Reference !== undefined && !['DELETED', 'VOIDED'].includes(patch.Status ?? '') && after.Reference !== patch.Reference) ||
        (patch.CurrencyCode !== undefined && after.CurrencyCode !== patch.CurrencyCode) ||
        (patch.CurrencyRate !== undefined && after.CurrencyRate !== patch.CurrencyRate) ||
        (patch.Status !== undefined && after.Status !== patch.Status);
      if (invariantsChanged || mismatched) throw new XeroError('verification', 'invoice_verification', 'The write was applied but verification found unexpected or unchanged fields. Inspect the invoice, exchange rate, dates, totals and payment state; do not retry automatically.', true);
      return { invoice: after, ...(patch.Reference !== undefined && ['DELETED', 'VOIDED'].includes(patch.Status ?? '') ? { warning: 'Xero may ignore Reference during deletion or voiding. Add and verify a separate history note for the correction explanation.' } : {}) };
    },
    async addHistory(tenantId: string, invoiceId: string, details: string, key: string, callerSignal?: AbortSignal) {
      id.parse(invoiceId); await readInvoice(tenantId, invoiceId, callerSignal);
      const response = await request(tenantId, `/Invoices/${invoiceId}/History`, 'PUT', { HistoryRecords: [{ Details: details }] }, {}, callerSignal, key);
      try {
        const history = await request(tenantId, `/Invoices/${invoiceId}/History`, 'GET', undefined, {}, callerSignal);
        const parsed = z.object({ HistoryRecords: z.array(z.object({ Details: z.string() })) }).safeParse(history);
        if (!parsed.success || !parsed.data.HistoryRecords.some(note => note.Details === details)) throw new Error();
        return { response, history };
      } catch { throw new XeroError('verification', 'history_verification', 'The history write may be saved, but its note could not be verified. Inspect invoice history before retrying.', true); }
    },
    async createPayment(tenantId: string, input: { invoiceId: string; accountId: string; amount: number; currency: string; date: string; reference?: string }, key: string, callerSignal?: AbortSignal) {
      const before = await readInvoice(tenantId, input.invoiceId, callerSignal);
      if (before.Status !== 'AUTHORISED' || typeof before.AmountDue !== 'number' || input.amount <= 0 || input.amount > before.AmountDue) fail('Payment requires an AUTHORISED invoice and a positive amount no greater than its verified amount due. Check existing payments first.');
      id.parse(input.accountId);
      const accounts = await request(tenantId, `/Accounts/${input.accountId}`, 'GET', undefined, {}, callerSignal) as { Accounts?: Record<string, unknown>[] };
      const account = accounts.Accounts?.find(a => a.AccountID === input.accountId);
      if (!account || account.Status !== 'ACTIVE' || (account.Type !== 'BANK' && account.EnablePaymentsToAccount !== true)) fail('Choose an active bank account or an account enabled for payments.');
      if (input.currency !== before.CurrencyCode || account.CurrencyCode !== input.currency) fail('This tool records same-currency payments only. For foreign-currency withdrawals, use the manual handoff with separate bill-currency Payment amount and bank-currency Bank amount. Do not send money again.');
      const payments = Array.isArray(before.Payments) ? before.Payments as Record<string, unknown>[] : [];
      if (payments.some(p => p.Amount === input.amount && (paymentDate(p.DateString) === input.date || paymentDate(p.Date) === input.date))) fail('A payment with the same date and amount already exists. Inspect it and match the existing payment instead of recording another.');
      const response = await request(tenantId, '/Payments', 'POST', { Payments: [{ Invoice: { InvoiceID: input.invoiceId }, Account: { AccountID: input.accountId }, Amount: input.amount, Date: input.date, Reference: input.reference }] }, {}, callerSignal, key);
      const receipt = z.object({ Payments: z.array(z.object({ PaymentID: id, Amount: z.number() })).length(1) }).safeParse(response);
      if (!receipt.success || receipt.data.Payments[0]!.Amount !== input.amount) throw new XeroError('verification', 'payment_verification', 'Xero did not confirm the requested payment. It may already be saved. Inspect the invoice and payments before retrying.', true);
      const after = await verify(tenantId, input.invoiceId, callerSignal);
      if (typeof after.AmountDue !== 'number' || Math.abs(after.AmountDue - (before.AmountDue - input.amount)) > 0.005)
        throw new XeroError('verification', 'payment_verification', 'The payment request was accepted, but the remaining balance did not verify. Inspect invoice payments before retrying.', true);
      return { response, invoice: after, notice: 'Records a payment made outside Xero; does not send money or reconcile a statement line.' };
    },
    async attach(tenantId: string, invoiceId: string, fileName: string, bytes: Uint8Array, contentType: string, key: string, callerSignal?: AbortSignal) {
      id.parse(invoiceId); await readInvoice(tenantId, invoiceId, callerSignal);
      const response = await request(tenantId, `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(fileName)}`, 'POST', bytes, { IncludeOnline: false }, callerSignal, key, contentType);
      try {
        const listing = await request(tenantId, `/Invoices/${invoiceId}/Attachments`, 'GET', undefined, {}, callerSignal);
        const parsed = z.object({ Attachments: z.array(z.object({ FileName: z.string(), ContentLength: z.number() })) }).safeParse(listing);
        if (!parsed.success || !parsed.data.Attachments.some(file => file.FileName === fileName && file.ContentLength === bytes.byteLength)) throw new Error();
        return { response, verified: 'Attachment name and byte length verified on the invoice.' };
      } catch { throw new XeroError('verification', 'attachment_verification', 'The attachment may have been saved, but its name and length could not be verified. Inspect attachments before retrying or archiving source email.', true); }
    },
  };
}
