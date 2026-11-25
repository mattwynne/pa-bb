import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, requestSchema, ApiResultError, ApiRequestError } from '../api.ts';
import { catalog, API_NAMES, listOperations, describeOperation, readSchema } from '../catalog.ts';
import { diagnostic, feedback } from '../diagnostic.ts';
import { TENANT, INVOICE, ACCOUNT, KEY, tokens, world } from './support.ts';
function apiWorld() {
  const w = world(); w.seed(); const downloads: { bytes: Buffer; mime: string; name: string }[] = [];
  const api = createApi({ connection: w.connection, fetcher: w.fetcher, signal: w.controller.signal,
    async save(bytes, mime, name) { downloads.push({ bytes, mime, name }); return { name, size: bytes.length }; } });
  w.setHandler(() => Response.json({ okay: true }));
  return { ...w, downloads, request: (input: unknown) => api.request(requestSchema.parse(input)) };
}
test('catalog covers every callable official API family, all 485 operations and resolvable schema references', () => {
  assert.equal(API_NAMES.reduce((n, api) => n + catalog.families[api].operations.length, 0), 485);
  for (const api of API_NAMES) {
    const family = catalog.families[api]; assert.equal(new URL(family.baseUrl).origin, 'https://api.xero.com');
    assert.equal(new Set(family.operations.map(o => o.id)).size, family.operations.length);
    for (const ref of JSON.stringify(family).matchAll(/"\$ref":"#\/components\/schemas\/([^"/]+)"/g)) assert.ok(family.schemas[ref[1]!], `${api}: ${ref[1]}`);
  }
  assert.equal(listOperations({ api: 'accounting', search: 'invoice pdf' }).operations[0]!.id, 'getInvoiceAsPdf');
  const first = listOperations({ pageSize: 5 }); assert.equal(first.total, 485); assert.equal(first.nextPage, 2);
  assert.equal(describeOperation('accounting', 'getInvoiceAsPdf').wirePath, '/Invoices/{InvoiceID}');
  assert.ok(readSchema('accounting', 'Payment', '/properties/BankAmount').schema);
  assert.throws(() => readSchema('accounting', 'Payment', '/__proto__'));
  assert.throws(() => readSchema('accounting', '__proto__'));
});
test('every catalog operation can be routed with its method, wire path, inherited tenant header and body encoding', async () => {
  const w = apiWorld(), root = await mkdtemp(join(tmpdir(), 'xero-api-coverage-')), path = join(root, 'source.bin'); await writeFile(path, 'original bytes');
  w.client.enableAppStore = true;
  w.setHandler(url => url.hostname === 'identity.xero.com' ? Response.json({ ...tokens, scope: 'marketplace.billing' }) : Response.json({ okay: true }));
  try {
    for (const api of API_NAMES) for (const op of catalog.families[api].operations) {
      const parameters: Record<string, unknown> = {};
      const pathNames = [...op.wirePath.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      for (const p of op.parameters) {
        if (['xero-tenant-id', 'idempotency-key', 'contenttype'].includes(p.name.toLowerCase())) continue;
        if (!p.required && !pathNames.includes(p.name)) continue;
        parameters[p.name] = p.schema?.type === 'integer' ? 1 : p.schema?.type === 'boolean' ? true : p.schema?.type === 'array' ? [INVOICE] : p.name.toLowerCase().includes('filename') ? 'source.bin' : INVOICE;
      }
      for (const name of pathNames) if (parameters[name!] === undefined) parameters[name!] = INVOICE;
      const type = Object.keys(op.requestBody?.content ?? {})[0];
      const body = op.requestBody ? type === 'application/json' ? { body: {} } : { upload: { filePath: path } } : {};
      const result = await w.request({ api, operationId: op.id, tenantId: api === 'app-store' || api === 'identity' ? undefined : TENANT, parameters, ...body });
      assert.equal(result.httpStatus, 200, `${api}:${op.id}`);
      const call = w.calls.at(-1)!; assert.equal(call.init.method, op.method, op.id);
      assert.equal(call.url.origin, 'https://api.xero.com'); assert.ok(call.url.pathname.startsWith(new URL(catalog.families[api].baseUrl).pathname));
      if (api !== 'identity' && api !== 'app-store') assert.equal((call.init.headers as Record<string, string>)['xero-tenant-id'], TENANT, op.id);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('contacts, account enablement, invoice email, cross-currency payment and raw future endpoints are not artificially restricted', async () => {
  const w = apiWorld();
  for (const input of [
    { operationId: 'createContacts', body: { Contacts: [{ Name: 'Example customer', EmailAddress: 'customer@example.test' }] } },
    { operationId: 'updateAccount', parameters: { AccountID: ACCOUNT }, body: { Accounts: [{ EnablePaymentsToAccount: true }] } },
    { operationId: 'emailInvoice', parameters: { InvoiceID: INVOICE }, body: {} },
    { operationId: 'createPayments', body: { Payments: [{ Invoice: { InvoiceID: INVOICE }, Amount: 100, BankAmount: 140, Account: { AccountID: ACCOUNT } }] } },
    { path: '/FutureProviderEndpoint', method: 'PATCH', body: { ProviderAddedField: 'preserved' } },
  ]) {
    await w.request({ api: 'accounting', tenantId: TENANT, idempotencyKey: KEY, ...input });
    assert.equal(w.calls.at(-1)!.init.body, JSON.stringify(input.body));
    assert.equal((w.calls.at(-1)!.init.headers as Record<string, string>)['Idempotency-Key'], KEY);
  }
});
test('PDF alias, binary downloads and JSON downloads preserve bytes without returning base64 into model context', async () => {
  const w = apiWorld(), bytes = Buffer.from('%PDF-1.7\noriginal');
  w.setHandler(() => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
  const result = await w.request({ tenantId: TENANT, operationId: 'getInvoiceAsPdf', parameters: { InvoiceID: INVOICE } });
  assert.equal(w.calls[0]!.url.pathname, `/api.xro/2.0/Invoices/${INVOICE}`); assert.equal((w.calls[0]!.init.headers as Record<string, string>).Accept, 'application/pdf');
  assert.deepEqual(w.downloads[0]!.bytes, bytes); assert.ok('download' in result && result.download); assert.doesNotMatch(JSON.stringify(result), /original|base64/);
  w.setHandler(() => Response.json({ Invoices: [{ InvoiceID: INVOICE }] }));
  await w.request({ tenantId: TENANT, path: '/Invoices', downloadName: 'invoices.json' }); assert.equal(w.downloads[1]!.name, 'invoices.json');
});
test('multipart and binary uploads preserve original bytes and provider encoding without extension restrictions', async () => {
  const w = apiWorld(), root = await mkdtemp(join(tmpdir(), 'xero-upload-')), path = join(root, 'original.docx'), bytes = Buffer.from([0, 255, 128, 7]);
  try {
    await writeFile(path, bytes);
    await w.request({ api: 'files', tenantId: TENANT, operationId: 'uploadFile', upload: { filePath: path, contentType: 'application/octet-stream' } });
    const form = w.calls.at(-1)!.init.body; assert.ok(form instanceof FormData);
    const file = form.get('body'); assert.ok(file instanceof Blob); assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal(form.get('filename'), 'original.docx'); assert.ok(!('Content-Type' in (w.calls.at(-1)!.init.headers as Record<string, string>)), 'fetch owns the multipart boundary');
    await w.request({ tenantId: TENANT, operationId: 'createInvoiceAttachmentByFileName', parameters: { InvoiceID: INVOICE, FileName: 'original.docx' }, upload: { filePath: path, contentType: 'application/octet-stream' } });
    assert.deepEqual(w.calls.at(-1)!.init.body, bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('request arrays follow declared serialization, safe conditional headers allow 304, and empty write results allow 204', async () => {
  const w = apiWorld();
  await w.request({ tenantId: TENANT, operationId: 'getInvoices', parameters: { IDs: [INVOICE, ACCOUNT], 'If-Modified-Since': '2026-01-01T00:00:00Z' } });
  assert.equal(w.calls[0]!.url.searchParams.get('IDs'), INVOICE + ',' + ACCOUNT);
  assert.equal((w.calls[0]!.init.headers as Record<string, string>)['If-Modified-Since'], '2026-01-01T00:00:00Z');
  w.setHandler(() => new Response(null, { status: 304 })); assert.equal((await w.request({ tenantId: TENANT, path: '/Contacts' })).httpStatus, 304);
  w.setHandler(() => new Response(null, { status: 204 })); const deleted = await w.request({ api: 'files', tenantId: TENANT, operationId: 'deleteFile', parameters: { FileId: INVOICE } }); assert.ok('data' in deleted); assert.equal(deleted.data, null);
});
test('external hosts, header overrides, traversal and mismatched operation methods fail before provider calls', async () => {
  const w = apiWorld();
  for (const bad of [
    { path: 'https://evil.test' }, { path: '//evil.test' }, { path: '/../Connections' }, { path: '/%252e%252e/Connections' },
    { path: '/Invoices?secret=x' }, { path: '/Invoices\\..\\Connections' },
    { operationId: 'getInvoice', parameters: { InvoiceID: '../../Connections' } },
    { path: '/Invoices', headers: { Authorization: 'SECRET' } }, { path: '/Invoices', headers: { 'xero-tenant-id': INVOICE } },
    { operationId: 'getInvoices', method: 'DELETE' }, { operationId: 'getInvoices', parameters: { UnknownParameter: 'SECRET' } },
    { api: 'identity', path: '/connect/token', method: 'POST', body: {} },
  ]) await assert.rejects(w.request({ tenantId: TENANT, ...bad }));
  assert.equal(w.calls.length, 0);
});
test('HTTP 200 batch/partner partial failures preserve safe receipts, not private error messages or false success', async () => {
  const w = apiWorld();
  for (const data of [
    { Invoices: [{ InvoiceID: INVOICE, HasErrors: false }, { InvoiceID: ACCOUNT, HasErrors: true, ValidationErrors: [{ Message: 'SECRET_TOKEN PRIVATE_ACCOUNT' }] }] },
    { items: [{ status: 'PARTIAL_FAILURE', error: { accountId: ACCOUNT, title: 'SECRET_TOKEN PRIVATE_ACCOUNT' } }] },
  ]) {
    w.setHandler(() => Response.json(data));
    await assert.rejects(w.request({ tenantId: TENANT, path: '/Invoices', method: 'POST', body: {}, idempotencyKey: KEY }), error => {
      assert.ok(error instanceof ApiResultError); assert.match(diagnostic(error, 'tool_call'), /api_result provider_result/);
      assert.ok(error.receipt.observedIds.includes(ACCOUNT)); assert.equal(error.receipt.idempotencyKey, KEY);
      assert.doesNotMatch(JSON.stringify(error.receipt) + feedback(error), /SECRET_TOKEN|PRIVATE_ACCOUNT/); return true;
    });
  }
});
test('uncertain writes are never retried and no synthetic provider message is exposed', async () => {
  const w = apiWorld(); w.setHandler(() => { throw new Error('SECRET_ERROR PRIVATE_ACCOUNT'); });
  await assert.rejects(w.request({ tenantId: TENANT, path: '/Payments', method: 'POST', body: {} }), error => { assert.match(feedback(error), /may have been applied/); assert.doesNotMatch(feedback(error), /SECRET|PRIVATE/); assert.ok(error instanceof ApiRequestError); assert.match(error.receipt.idempotencyKey ?? '', /^[a-f\d-]{36}$/); return true; });
  assert.equal(w.calls.length, 1);
});
test('documented services outside OpenAPI remain callable, including XML practice requests and Xero platform paths', async () => {
  const w = apiWorld(), xml = '<Job><Name>Requested job</Name></Job>';
  await w.request({ api: 'practice-manager', tenantId: TENANT, path: '/job.api/add', method: 'POST', textBody: xml });
  assert.equal(w.calls.at(-1)!.url.pathname, '/practicemanager/3.1/job.api/add'); assert.equal(w.calls.at(-1)!.init.body, xml);
  assert.equal((w.calls.at(-1)!.init.headers as Record<string, string>)['Content-Type'], 'application/xml');
  await w.request({ api: 'einvoicing', tenantId: TENANT, path: '/registrations' }); assert.match(w.calls.at(-1)!.url.pathname, /einvoicing\.xro\/1\.0\/registrations/);
  await w.request({ api: 'platform', tenantId: TENANT, path: '/another-documented-xero-service', headers: { 'Xero-Practice-Id': ACCOUNT } });
  assert.equal((w.calls.at(-1)!.init.headers as Record<string, string>)['Xero-Practice-Id'], ACCOUNT);
  w.setHandler(() => new Response('<Response><Status>OK</Status><Jobs /></Response>', { headers: { 'content-type': 'application/xml; charset=utf-8' } }));
  const response = await w.request({ api: 'practice-manager', tenantId: TENANT, path: '/job.api/current' });
  assert.ok('data' in response); assert.match(String(response.data), /<Jobs/); assert.equal(w.downloads.length, 0);
  for (const encoding of ['utf-8', 'utf-16le']) {
    w.setHandler(() => new Response(Buffer.from('<Response><Status>ERROR</Status><ErrorDescription>SECRET_XML</ErrorDescription></Response>', encoding === 'utf-8' ? 'utf8' : 'utf16le'), { headers: { 'content-type': 'application/xml; charset=' + encoding } }));
    await assert.rejects(w.request({ api: 'practice-manager', tenantId: TENANT, path: '/job.api/add', method: 'POST', textBody: xml }), e => { assert.ok(e instanceof ApiResultError); assert.doesNotMatch(feedback(e), /SECRET_XML/); return true; });
  }
});
test('App Store uses an explicitly enabled client-credentials grant, not the login token or a silent permission expansion', async () => {
  const w = apiWorld();
  await assert.rejects(w.request({ api: 'app-store', operationId: 'getSubscription', parameters: { subscriptionId: INVOICE } }), /Enable App Store/); assert.equal(w.calls.length, 0);
  w.client.enableAppStore = true;
  w.setHandler(url => url.hostname === 'identity.xero.com' ? Response.json({ access_token: 'SECRET_APPLICATION', expires_in: 1800, scope: 'marketplace.billing' }) : Response.json({ id: INVOICE }));
  await w.request({ api: 'app-store', operationId: 'getSubscription', parameters: { subscriptionId: INVOICE } });
  assert.equal(new URLSearchParams(w.calls[0]!.init.body as URLSearchParams).get('grant_type'), 'client_credentials');
  assert.equal((w.calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer SECRET_APPLICATION');
  assert.ok(!('xero-tenant-id' in (w.calls[1]!.init.headers as Record<string, string>)));
});
