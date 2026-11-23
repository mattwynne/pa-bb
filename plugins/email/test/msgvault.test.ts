import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MsgVault } from '../msgvault.ts';

test('MsgVault imports, deduplicates, searches isolated archives, and returns readable mail', async t => {
  const vault = new MsgVault(category => assert.fail(category));
  const signal = AbortSignal.timeout(45_000);
  const availability = await vault.check(signal);
  if (!process.env.BB_EMAIL_TEST_MSGVAULT && availability !== 'ready') return t.skip('Requires MsgVault 0.26 on PATH');
  assert.equal(availability, 'ready');
  const root = await mkdtemp(join(tmpdir(), 'bb-email-test-'));
  t.after(async () => { await vault.close(); await rm(root, { recursive: true, force: true }); });
  const folder = join(root, 'batch');
  const mailbox = join(folder, 'Archive.mailbox');
  await mkdir(mailbox, { recursive: true });
  await writeFile(join(mailbox, '1.eml'), [
    'From: Sender <sender@example.test>', 'To: Receiver <receiver@example.test>',
    'Date: Tue, 10 Nov 2026 11:22:33 +0000', 'Message-ID: <synthetic@example.test>',
    'Subject: Synthetic invoice', '', 'The invoices identify an orangepenguin.', '',
  ].join('\r\n'));
  const first = join(root, 'account-a');
  const second = join(root, 'account-b');
  await vault.import(first, 'account-a', folder, 1, signal);
  await vault.import(first, 'account-a', folder, 1, signal);
  const found = await vault.search(first, 'from:sender@example.test orangepenguin', 5, signal);
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, 'Synthetic invoice');
  assert.deepEqual(await vault.search(second, 'orangepenguin', 5, signal), []);
  const email = await vault.read(first, found[0].id, signal);
  assert.match(email.body, /orangepenguin/);
  assert.equal(email.to[0].email, 'receiver@example.test');
});
