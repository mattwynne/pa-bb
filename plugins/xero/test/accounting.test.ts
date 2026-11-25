import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccounting } from '../accounting.ts';
import { diagnostic, feedback } from '../diagnostic.ts';
import { ACCOUNT, INVOICE, KEY, OTHER, TENANT, invoice, world } from './support.ts';

function accountingWorld() {
  const w = world(); w.seed(); let current: Record<string, unknown> = invoice(); let writeResponse: Response | undefined;
  const account = { AccountID: ACCOUNT, Type: 'BANK', Status: 'ACTIVE', CurrencyCode: 'USD' };
  const history: { Details: string }[] = [], attachments: { FileName: string; ContentLength: number }[] = [];
  w.setHandler((url, init) => {
    const path = url.pathname;
    if (init.method === 'POST' || init.method === 'PUT') {
      if (writeResponse) return writeResponse;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (path.endsWith('/Payments')) {
        const p = { ...body.Payments[0], PaymentID: OTHER }; current = { ...current, AmountDue: Number(current.AmountDue) - p.Amount, AmountPaid: p.Amount, Payments: [p] };
        return Response.json({ Payments: [p] });
      }
      if (path.endsWith('/History')) { history.push(...body.HistoryRecords); return Response.json({ HistoryRecords: history }); }
      if (path.includes('/Attachments/')) { attachments.push({ FileName: decodeURIComponent(path.split('/').at(-1)!), ContentLength: (init.body as Uint8Array).byteLength }); return Response.json({ Attachments: attachments }); }
      current = { ...current, ...body.Invoices[0] };
      if (body.Invoices[0].CurrencyCode && body.Invoices[0].CurrencyRate === undefined) current.CurrencyRate = 0.81;
      return Response.json({ Invoices: [current] });
    }
    if (path.includes('/Accounts/')) return Response.json({ Accounts: [account] });
    if (path.endsWith('/History')) return Response.json({ HistoryRecords: history });
    if (path.endsWith('/Attachments')) return Response.json({ Attachments: attachments });
    return Response.json({ Invoices: [current] });
  });
  const accounting = createAccounting({ connection: w.connection, fetcher: w.fetcher, signal: w.controller.signal });
  return { ...w, accounting, account, get current() { return current; }, set current(value) { current = value; }, failWrite(response: Response) { writeResponse = response; }, writes: () => w.calls.filter(c => c.init.method !== 'GET') };
}

test('read routes enforce Xero Accounting origin, GET only and explicit tenant', async () => {
  const w = accountingWorld();
  await w.accounting.read(TENANT, '/Accounts', { where: 'Type=="BANK"', page: 1 });
  const c = w.calls[0]!; assert.equal(c.url.origin, 'https://api.xero.com'); assert.equal(c.url.pathname, '/api.xro/2.0/Accounts');
  assert.equal(c.url.searchParams.get('where'), 'Type=="BANK"'); assert.equal(c.init.method, 'GET');
  assert.equal((c.init.headers as Record<string, string>)['xero-tenant-id'], TENANT);
  for (const path of ['https://evil.test', '//evil.test', '/../connections', '/Invoices/../../connections', '/Invoices?foo=bar', '/BankStatements', '/Invoices\\..\\..\\connections', '/Invoices/%2e%2e']) await assert.rejects(w.accounting.read(TENANT, path));
  await assert.rejects(w.accounting.read(OTHER, '/Accounts')); assert.equal(w.calls.length, 1);
});
test('reference-only edit preserves FX and verifies dates, totals and payment state', async () => {
  const w = accountingWorld(), before = { ...w.current };
  const result = await w.accounting.updateInvoice(TENANT, INVOICE, { Reference: 'Requested reference' }, KEY);
  assert.equal(result.invoice.Reference, 'Requested reference');
  const c = w.writes()[0]!, body = JSON.parse(c.init.body as string);
  assert.equal(body.Invoices[0].CurrencyRate, before.CurrencyRate);
  assert.equal(body.Invoices[0].InvoiceID, INVOICE);
  assert.equal((c.init.headers as Record<string, string>)['Idempotency-Key'], KEY);
  assert.equal(w.calls.length, 3); assert.equal(w.writes().length, 1);
  for (const field of ['CurrencyCode', 'CurrencyRate', 'Total', 'AmountPaid', 'AmountDue', 'Date', 'DueDate']) assert.equal(result.invoice[field], before[field]);
});
test('currency changes never reuse the old rate and must stay DRAFT', async () => {
  const w = accountingWorld();
  await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { CurrencyCode: 'EUR' }, KEY), /remains DRAFT/); assert.equal(w.writes().length, 0);
  w.current = { ...w.current, Status: 'DRAFT' };
  await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { CurrencyCode: 'EUR', CurrencyRate: 1 }, KEY), /old rate/);
  await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { CurrencyCode: 'EUR', Status: 'AUTHORISED' }, KEY), /remains DRAFT/);
  const result = await w.accounting.updateInvoice(TENANT, INVOICE, { CurrencyCode: 'EUR' }, KEY);
  assert.equal(result.invoice.CurrencyRate, 0.81); assert.equal(result.invoice.Status, 'DRAFT');
  assert.ok(!('CurrencyRate' in JSON.parse(w.writes()[0]!.init.body as string).Invoices[0]));
});
test('missing FX data and injected InvoiceID fail before mutation', async () => {
  const w = accountingWorld(); w.current = { ...w.current, CurrencyRate: null };
  await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { Reference: 'r' }, KEY), /exchange rate could not be verified/);
  await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { InvoiceID: OTHER } as never, KEY)); assert.equal(w.writes().length, 0);
});
test('HTTP 200 validation-error results are errors, not successful writes', async () => {
  const w = accountingWorld(); w.failWrite(Response.json({ Invoices: [{ HasErrors: true, ValidationErrors: [{ Message: 'SECRET_VALIDATION PRIVATE_ACCOUNT' }] }] }));
  await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { Reference: 'r' }, KEY), e => {
    assert.match(diagnostic(e, 'tool_call'), /accounting_result provider_result/); assert.doesNotMatch(feedback(e), /SECRET|PRIVATE_ACCOUNT/); return true;
  }); assert.equal(w.writes().length, 1);
});
test('transport errors and failed verification never retry a possibly-applied write', async () => {
  for (const mode of ['transport', 'verify', 'changed']) {
    const w = accountingWorld(); let reads = 0, writes = 0;
    w.setHandler((_url, init) => {
      if (init.method === 'POST') { writes++; if (mode === 'transport') throw new Error('SECRET_TRANSPORT'); return Response.json({ Invoices: [invoice()] }); }
      reads++; if (reads > 1 && mode === 'verify') throw new Error('SECRET_VERIFY');
      return Response.json({ Invoices: [{ ...invoice(), ...(reads > 1 ? { Reference: 'r', CurrencyRate: 1 } : {}) }] });
    });
    await assert.rejects(w.accounting.updateInvoice(TENANT, INVOICE, { Reference: 'r' }, KEY), e => {
      assert.doesNotMatch(feedback(e), /SECRET/); assert.match(feedback(e), /may|applied/); return true;
    }); assert.equal(writes, 1);
  }
});
test('creation requires original currency/contact/date and remains draft, then reads back', async () => {
  const w = accountingWorld();
  await assert.rejects(w.accounting.createInvoice(TENANT, { Type: 'ACCPAY' }, KEY));
  const fields = { Type: 'ACCPAY' as const, Contact: { ContactID: OTHER }, LineItems: [{ Description: 'Consulting', Quantity: 1, UnitAmount: 100, AccountCode: '200' }], Date: '2026-01-01', CurrencyCode: 'USD' };
  await assert.rejects(w.accounting.createInvoice(TENANT, { ...fields, Status: 'AUTHORISED' }, KEY));
  const result = await w.accounting.createInvoice(TENANT, fields, KEY); assert.equal(result.Status, 'DRAFT'); assert.equal(w.writes().length, 1);
});
test('same-currency existing payment recording verifies invoice and refuses cross-currency or overpayment', async () => {
  const w = accountingWorld(), input = { invoiceId: INVOICE, accountId: ACCOUNT, amount: 40, currency: 'USD', date: '2026-01-01' };
  await assert.rejects(w.accounting.createPayment(TENANT, { ...input, amount: 101 }, KEY), /amount due/);
  w.account.CurrencyCode = 'CAD'; await assert.rejects(w.accounting.createPayment(TENANT, input, KEY), /same-currency/);
  w.account.CurrencyCode = 'USD';
  for (const dateFields of [{ DateString: input.date }, { DateString: input.date + 'T00:00:00' }, { Date: input.date + 'T00:00:00Z' }, { Date: '/Date(1767225600000+0000)/' }]) {
    w.current.Payments = [{ Amount: 40, ...dateFields }];
    await assert.rejects(w.accounting.createPayment(TENANT, input, KEY), /already exists/);
  }
  w.current.Payments = []; const result = await w.accounting.createPayment(TENANT, input, KEY);
  assert.equal(result.invoice.AmountDue, 60); assert.equal(w.writes().length, 1); assert.match(result.notice, /does not send money/);
});
test('unconfirmed payment, history and attachment responses cannot be reported as saved', async () => {
  for (const mode of ['payment', 'history', 'attachment']) {
    const w = accountingWorld(); w.failWrite(Response.json({}));
    const action = mode === 'payment' ? w.accounting.createPayment(TENANT, { invoiceId: INVOICE, accountId: ACCOUNT, amount: 40, currency: 'USD', date: '2026-01-01' }, KEY)
      : mode === 'history' ? w.accounting.addHistory(TENANT, INVOICE, 'Requested note', KEY)
      : w.accounting.attach(TENANT, INVOICE, 'source.pdf', Buffer.from('%PDF-test'), 'application/pdf', KEY);
    await assert.rejects(action, /confirm|verif|inspect/i); assert.equal(w.writes().length, 1);
  }
});
test('history correction is separate and read back; attachments never publish online', async () => {
  const w = accountingWorld(); const result = await w.accounting.addHistory(TENANT, INVOICE, 'Correction explanation', KEY);
  assert.match(JSON.stringify(result.history), /Correction explanation/); assert.equal(w.writes()[0]!.init.method, 'PUT');
  await w.accounting.attach(TENANT, INVOICE, 'original evidence.pdf', Buffer.from('%PDF-test'), 'application/pdf', KEY);
  const call = w.writes()[1]!; assert.equal(call.url.searchParams.get('IncludeOnline'), 'false'); assert.match(call.url.pathname, /original%20evidence\.pdf$/);
});
