import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachment } from '../attachment.ts';
test('attachments accept bounded original document bytes and reject secret-like files, symlinks and mismatched signatures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xero-doc-'));
  try {
    const doc = join(root, 'source.pdf'); await writeFile(doc, '%PDF-1.7\nOriginal source');
    const file = await attachment(doc); assert.equal(file.contentType, 'application/pdf'); assert.equal(file.fileName, 'source.pdf');
    await writeFile(join(root, 'secret.json'), 'SECRET_TOKEN');
    await writeFile(join(root, 'fake.pdf'), 'SECRET_TOKEN');
    await writeFile(join(root, 'big.pdf'), '%PDF-' + 'x'.repeat(3_000_000));
    await symlink(doc, join(root, 'link.pdf'));
    for (const path of ['secret.json', 'fake.pdf', 'big.pdf', 'link.pdf', 'missing.pdf']) await assert.rejects(attachment(join(root, path)), e => {
      assert.doesNotMatch(String(e), /SECRET|xero-doc-|ENOENT/); return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
