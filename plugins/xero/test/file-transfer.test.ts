import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, symlink, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readUpload, saveDownload } from '../file-transfer.ts';
test('general uploads preserve arbitrary source types; downloads are private, no-overwrite and byte-verified in current thread storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xero-transfer-')), bytes = Buffer.from([0, 1, 2, 255, 128]);
  try {
    const source = join(root, 'source.docx'); await writeFile(source, bytes);
    const upload = await readUpload(source); assert.deepEqual(upload.bytes, bytes);
    const one = await saveDownload(root, 'thread-example', 'document.docx', 'application/octet-stream', bytes, new AbortController().signal);
    const two = await saveDownload(root, 'thread-example', 'document.docx', 'application/octet-stream', bytes, new AbortController().signal);
    assert.notEqual(one.source.path, two.source.path); assert.equal(one.source.threadId, 'thread-example');
    assert.deepEqual(await readFile(join(root, one.source.path)), bytes); assert.equal((await stat(join(root, one.source.path))).mode & 0o777, 0o600);
    assert.match(one.sha256, /^[a-f\d]{64}$/);
    await symlink(source, join(root, 'linked.docx')); await assert.rejects(readUpload(join(root, 'linked.docx')));
    await assert.rejects(saveDownload(root, 'thread-example', '../escape', 'text/plain', bytes, new AbortController().signal));
    const before = await readdir(root); const controller = new AbortController(); controller.abort();
    await assert.rejects(saveDownload(root, 'thread-example', 'cancelled', 'text/plain', bytes, controller.signal)); assert.deepEqual(await readdir(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
