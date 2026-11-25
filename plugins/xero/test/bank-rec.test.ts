import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, renderBankRecInstaller, readCaptureFile } from '../bank-rec.ts';
import { diagnostic, feedback } from '../diagnostic.ts';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const tenant = '11111111-1111-4111-8111-111111111111', account = '44444444-4444-4444-8444-444444444444';
function sample() { return { format: 'xero-bank-rec-capture', version: 1, capturedAt: '2026-09-12T12:00:00Z', coverage: { visibleOnly: true, complete: false }, account: { AccountID: account, Name: 'Example bank', CurrencyCode: 'CAD' }, url: `https://go.xero.com/BankRec/BankRec.aspx?accountId=${account}`, lines: [{ date: '12 Sep 2026', payee: 'Example', spent: '1,000.00', received: null, reference: null, text: 'PRIVATE_BANK_LINE', x: 100, y: 100 }] }; }
const now = Date.parse('2026-11-01T00:00:00Z');
test('imports legacy and tenant-bound capture formats without deduplicating distinct identical lines', () => {
  const v1 = sample(); v1.lines.push({ ...v1.lines[0]!, y: 170 });
  assert.equal(parseCapture(JSON.stringify(v1), tenant, now).lines.length, 2);
  const v2 = { ...v1, account: { ...v1.account, Code: '' }, version: 2, tenantId: tenant }; assert.equal(parseCapture(JSON.stringify(v2), tenant, now).tenantId, tenant);
});
test('malformed, unsupported, over-sized, misleading complete, wrong-account and impossible-date captures fail with no private data in diagnostics', () => {
  const bad: unknown[] = ['SECRET_TOKEN not JSON', JSON.stringify({ access_token: 'SECRET_TOKEN' }), JSON.stringify({ ...sample(), coverage: { visibleOnly: true, complete: true } }),
    JSON.stringify({ ...sample(), version: 2 }), JSON.stringify({ ...sample(), version: 2, tenantId: account }), JSON.stringify({ ...sample(), lines: [] }),
    JSON.stringify({ ...sample(), capturedAt: '2099-01-01T00:00:00Z' }), JSON.stringify({ ...sample(), url: 'https://other.example/?access_token=SECRET_TOKEN' }),
    JSON.stringify({ ...sample(), url: `https://go.xero.com/BankRec/BankRec.aspx?accountId=${account}&token=SECRET_TOKEN` }),
    JSON.stringify({ ...sample(), lines: [{ ...sample().lines[0], date: '31 Feb 2026' }] }),
    JSON.stringify({ ...sample(), lines: [{ ...sample().lines[0], received: '20.00' }] }),
    JSON.stringify({ ...sample(), account: { ...sample().account, AccessToken: 'SECRET_TOKEN' } }), 'x'.repeat(1_000_001)];
  for (const json of bad) assert.throws(() => parseCapture(json as string, tenant, now), error => { assert.doesNotMatch(feedback(error) + diagnostic(error, 'bank_rec_parse'), /SECRET|PRIVATE_BANK_LINE|access_token=/); return true; });
});
test('installer projects only safe account metadata and escapes account/organisation names without JavaScript/HTML injection', () => {
  const html = renderBankRecInstaller(tenant, [{ AccountID: account, Name: '</textarea><script>evil()</script>', CurrencyCode: 'CAD', BankAccountNumber: 'SECRET_BANK', token: 'SECRET_TOKEN' } as never], '<img src=x onerror=evil()>');
  assert.doesNotMatch(html, /SECRET|<script>|<img src=x/); assert.match(html, /&lt;script&gt;/); assert.match(html, /href="javascript:/);
});
test('server-file import is bounded, regular/no-follow and does not expose file contents or paths on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bank-rec-file-'));
  try {
    const path = join(root, 'capture.json'); await writeFile(path, JSON.stringify(sample())); assert.equal(JSON.parse(await readCaptureFile(path)).format, 'xero-bank-rec-capture');
    await symlink(path, join(root, 'link.json')); await writeFile(join(root, 'large.json'), 'x'.repeat(1_000_001));
    for (const file of ['link.json', 'large.json', 'missing.json']) await assert.rejects(readCaptureFile(join(root, file)), error => { assert.doesNotMatch(feedback(error), /bank-rec-file-|PRIVATE|ENOENT/); return true; });
  } finally { await rm(root, { recursive: true, force: true }); }
});
