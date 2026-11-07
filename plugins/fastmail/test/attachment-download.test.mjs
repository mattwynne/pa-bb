import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AttachmentError, downloadAttachment, attachmentStatus, MAX_ATTACHMENT_BYTES } from '../attachment-download.ts';
import { saveOriginal } from '../attachment-file.ts';
const MAIL = 'urn:ietf:params:jmap:mail';
const TOKEN = 'private-token-sentinel';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(root, changes = {}) {
  const bytes = changes.bytes ?? Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 7, 0, 1]);
  const request = { account: 'login@example.test', emailId: 'M1', blobId: 'B1', expectedName: 'Example.docx', expectedMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', expectedSize: bytes.length, ...changes.request };
  const attachment = { blobId: 'B1', name: request.expectedName, type: request.expectedMimeType, size: bytes.length, ...changes.attachment };
  const email = { id: 'M1', threadId: 'T1', messageId: ['synthetic@example.test'], receivedAt: '2026-01-02T12:00:00Z', attachments: [attachment], ...changes.email };
  const session = { username: 'login@example.test', apiUrl: 'https://synthetic.api.fastmail.com/jmap/api/', downloadUrl: 'https://download.gateway.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}', primaryAccounts: { [MAIL]: 'A1' }, accounts: { A1: { isPersonal: true, accountCapabilities: { [MAIL]: {} } } }, ...changes.session };
  const calls = []; const mcpCalls = [];
  const options = { location: async () => root, ensureCurrent() {}, ...changes.options,
    async mcp(name, args) {
      mcpCalls.push([name, args]);
      if (changes.mcpError) return { isError: true, content: [{ type: 'text', text: 'private-content-sentinel' }] };
      if (changes.mcpThrow) throw new Error('private-content-sentinel');
      assert.equal(name, 'read_email'); // No account equivalence inferred from sending aliases.
      const data = { ...email, ...changes.mcpEmail };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: changes.mcpStructured ?? Object.fromEntries(Object.entries(data).reverse()) };
    },
    async fetch(url, init) {
      calls.push([url, init]);
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(init.redirect, 'error');
      if (changes.fetchThrow) throw new Error('private-content-sentinel');
      if (url.includes('/session')) return changes.sessionResponse?.() ?? Response.json(session);
      if (url.includes('/download/')) return changes.download?.(init) ?? new Response(bytes, { headers: { 'Content-Type': request.expectedMimeType, 'Content-Length': String(bytes.length), ...changes.headers }, status: changes.httpStatus ?? 200 });
      const [method, args, id] = JSON.parse(init.body).methodCalls[0];
      assert.equal(method, 'Email/get'); // No identity/submission methods or provider writes.
      assert.deepEqual(JSON.parse(init.body).using, ['urn:ietf:params:jmap:core', MAIL]);
      assert.deepEqual(args.properties, ['id', 'threadId', 'messageId', 'receivedAt', 'attachments']);
      const data = { accountId: 'A1', notFound: [], list: [email], ...changes.methodResult };
      return Response.json({ methodResponses: [[changes.methodError ? 'error' : method, data, id]] });
    },
  };
  return { bytes, request, options, calls, mcpCalls, run: () => downloadAttachment(TOKEN, request, 'thr_synthetic', options) };
}
async function temp(run) { const root = await mkdtemp(join(tmpdir(), 'attachment-test-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('exact binary bytes, name, MIME, size, private regular file and persisted provenance; Drive-compatible source', () => temp(async root => {
  const f = fixture(root); const result = await f.run();
  assert.equal(result.status, 'downloaded'); assert.deepEqual(result.source, { host: 'bb-server', threadId: 'thr_synthetic', path: result.source.path });
  assert.match(result.source.path, /^fastmail-[a-f0-9-]+\/Example.docx$/);
  assert.deepEqual(await readFile(join(root, result.source.path)), f.bytes);
  assert.equal(result.sha256, sha(f.bytes)); assert.equal(result.sizeBytes, f.bytes.length);
  const st = await stat(join(root, result.source.path)); assert.equal(st.mode & 0o777, 0o600); assert.equal(st.nlink, 1);
  const directory = join(root, result.source.path.split('/')[0]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.provenance.json'), 'utf8')), result.provenance);
  assert.deepEqual((await readdir(directory)).sort(), ['.provenance.json', 'Example.docx']);
  assert.doesNotMatch(JSON.stringify(result), /private-token-sentinel|https:|Bearer/);
  assert.deepEqual(f.mcpCalls.map(c => c[0]), ['read_email']);
  assert.equal(result.provenance.identityBinding, 'authenticated-jmap-session');
}));
for (const type of ['application/pdf', 'image/png', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream']) {
  test(`ordinary binary MIME ${type} is neither opened nor converted`, () => temp(async root => {
    const f = fixture(root, { request: { expectedMimeType: type } }); const result = await f.run(); assert.equal(result.mimeType, type); assert.deepEqual(await readFile(join(root, result.source.path)), f.bytes);
  }));
}
test('mail-only preflight authenticates its independent account without MCP alias assumptions or email/byte/file access', () => temp(async root => {
  const f = fixture(root); const status = await attachmentStatus(TOKEN, f.options);
  assert.equal(status.account, 'login@example.test'); assert.equal(status.accountId, 'A1');
  assert.deepEqual(f.mcpCalls, []); assert.equal(f.calls.length, 1); assert.deepEqual(await readdir(root), []);
}));
for (const [name, changes, category] of [
  ['MCP Message-ID differs', { mcpEmail: { messageId: ['different@example.test'] } }, 'message_identity_mismatch'],
  ['MCP receivedAt differs', { mcpEmail: { receivedAt: '2026-01-02T13:00:00Z' } }, 'message_identity_mismatch'],
  ['MCP receivedAt invalid', { mcpEmail: { receivedAt: 'private-content-sentinel' } }, 'invalid_message_identity'],
  ['MCP Message-ID malformed', { mcpEmail: { messageId: 'private-content-sentinel' } }, 'invalid_message_identity'],
  ['text/structured metadata conflict', { mcpStructured: { id: 'M2' } }, 'invalid_response'],
  ['expected JMAP login differs', { request: { account: 'other@example.test' } }, 'account_mismatch'],
  ['missing mail capability', { session: { accounts: { A1: { isPersonal: true, accountCapabilities: {} } } } }, 'mail_access_missing'],
  ['missing primary account', { session: { primaryAccounts: {} } }, 'primary_account_missing'],
  ['missing session username', { session: { username: '' } }, 'session_username_missing'],
  ['nonpersonal primary account', { session: { accounts: { A1: { isPersonal: false } } } }, 'personal_account_required'],
  ['MCP permission denied', { mcpError: true }, 'provider_error_result'],
  ['MCP transport failure', { mcpThrow: true }, 'transport'],
  ['JMAP transport failure', { fetchThrow: true }, 'transport'],
  ['JMAP method rejection', { methodError: true }, 'provider_rejected'],
  ['mismatched method account', { methodResult: { accountId: 'A2' } }, 'invalid_response'],
  ['attachment not owned by email', { email: { attachments: [] } }, 'metadata_mismatch'],
  ['missing email', { methodResult: { list: [], notFound: ['M1'] } }, 'invalid_response'],
  ['MCP email mismatch', { mcpEmail: { id: 'M2' } }, 'invalid_response'],
  ['MCP conversation differs', { mcpEmail: { threadId: 'T2' } }, 'metadata_mismatch'],
  ['MCP size differs', { mcpEmail: { attachments: [{ blobId: 'B1', name: 'Example.docx', type: 'application/octet-stream', size: 1 }] } }, 'metadata_mismatch'],
  ['JMAP metadata differs', { attachment: { size: 1 } }, 'metadata_mismatch'],
  ['ambiguous attachment', { email: { attachments: [{ blobId: 'B1' }, { blobId: 'B1' }] } }, 'metadata_mismatch'],
  ['reported oversize', { request: { expectedSize: MAX_ATTACHMENT_BYTES + 1 } }, 'invalid_arguments'],
  ['unsafe email ID', { request: { emailId: '../../etc/passwd' } }, 'invalid_arguments'],
  ['unsafe blob ID', { request: { blobId: 'B1?token=private' } }, 'invalid_arguments'],
  ['unsafe name', { request: { expectedName: '../../outside.docx' } }, 'unsafe_filename'],
  ['unsafe Windows name', { request: { expectedName: 'C:\\outside.docx' } }, 'unsafe_filename'],
  ['control name', { request: { expectedName: 'file\n.docx' } }, 'unsafe_filename'],
  ['hidden name', { request: { expectedName: '.private' } }, 'unsafe_filename'],
  ['endpoint SSRF', { session: { apiUrl: 'https://example.test/jmap/api/' } }, 'api_endpoint_origin'],
  ['download SSRF', { session: { downloadUrl: 'https://localhost/jmap/download/{accountId}/{blobId}/{name}?type={type}' } }, 'download_endpoint_origin'],
  ['content domain lookalike', { session: { downloadUrl: 'https://fastmailusercontent.com.example.test/jmap/download/{accountId}/{blobId}/{name}?type={type}' } }, 'download_endpoint_origin'],
  ['content host cannot serve API metadata', { session: { apiUrl: 'https://download.gateway.fastmailusercontent.com/jmap/api/' } }, 'api_endpoint_origin'],
  ['signed download URL', { session: { downloadUrl: 'https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}&token=private' } }, 'download_endpoint_query'],
  ['unknown URL placeholder', { session: { downloadUrl: 'https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}/{unknown}?type={type}' } }, 'invalid_download_template'],
  ['wrong HTTP size', { headers: { 'Content-Length': '7' } }, 'metadata_mismatch'],
  ['wrong HTTP MIME', { headers: { 'Content-Type': 'text/html' } }, 'metadata_mismatch'],
  ['encoded response', { headers: { 'Content-Encoding': 'gzip' } }, 'metadata_mismatch'],
  ['HTTP denied', { httpStatus: 403 }, 'http_status=403'],
  ['redirect response', { httpStatus: 302 }, 'http_rejected'],
  ['HTTP missing blob', { httpStatus: 404 }, 'http_status=404'],
  ['truncated bytes', { download: () => new Response(Buffer.from([1]), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }) }, 'size_mismatch'],
  ['stream too large', { download: () => new Response(Buffer.alloc(9), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }) }, 'size_limit'],
  ['partial stream then failure', { download: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, pull(c) { c.error(new Error('private-content-sentinel')); } }), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }) }, 'transport'],
  ['malformed session', { sessionResponse: () => new Response('private-content-sentinel') }, 'invalid_response'],
  ['oversized session', { sessionResponse: () => new Response('x'.repeat(512 * 1024 + 1)) }, 'size_limit'],
]) test(`denies ${name} without a local artifact`, () => temp(async root => {
  const f = fixture(root, changes);
  await assert.rejects(f.run(), e => { assert.ok(e instanceof AttachmentError); assert.equal(e.category, category); assert.doesNotMatch(e.message, /private-|Bearer|https:/); return true; });
  assert.deepEqual(await readdir(root), []);
}));
test('a message without an RFC Message-ID still binds through native IDs, receivedAt and exact attachment membership', () => temp(async root => {
  const f = fixture(root, { email: { messageId: null } }); const result = await f.run();
  assert.equal(result.status, 'downloaded'); assert.equal(result.provenance.sourceMessage.messageId, null);
}));
test('an explicitly selected independent JMAP login requires no sending alias or submission capability', () => temp(async root => {
  const f = fixture(root, { request: { account: 'independent@example.test' }, session: { username: 'independent@example.test' } });
  const result = await f.run(); assert.equal(result.provenance.account, 'independent@example.test');
  assert.deepEqual(f.mcpCalls.map(c => c[0]), ['read_email']);
}));
test('stream cancellation bounds stalled reads and saves nothing', () => temp(async root => {
  const controller = new AbortController(); let cancelled = false;
  const f = fixture(root, { options: { signal: controller.signal }, download: () => {
    setTimeout(() => controller.abort(), 15);
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
  } });
  await assert.rejects(f.run(), e => e.category === 'cancelled'); assert.equal(cancelled, true); assert.deepEqual(await readdir(root), []);
}));
for (const boundary of ['fetch', 'mcp']) test(`cancellation bounds an unresponsive ${boundary} callback`, () => temp(async root => {
  const controller = new AbortController(); const f = fixture(root, { options: { signal: controller.signal } });
  f.options[boundary] = () => { setTimeout(() => controller.abort(), 10); return new Promise(() => {}); };
  await assert.rejects(f.run(), e => e.category === 'cancelled'); assert.deepEqual(await readdir(root), []);
}));
test('missing token never calls either provider', () => temp(async root => {
  const f = fixture(root); await assert.rejects(downloadAttachment(undefined, f.request, 'thr_synthetic', f.options), e => e.category === 'token_missing_or_invalid'); assert.equal(f.calls.length, 0); assert.equal(f.mcpCalls.length, 0);
}));
test('fresh directories prevent overwrite; collisions and symlink roots are refused', () => temp(async root => {
  const bytes = Buffer.from('original'); const proof = { sha256: sha(bytes) };
  const a = await saveOriginal(root, 'Same.docx', bytes, proof, () => {}); const b = await saveOriginal(root, 'Same.docx', bytes, proof, () => {}); assert.notEqual(a, b);
  await mkdir(join(root, 'fastmail-existing')); await assert.rejects(saveOriginal(root, 'Same.docx', bytes, proof, () => {}, { directoryName: () => 'fastmail-existing' }), e => e.category === 'storage_refused');
  assert.deepEqual(await readdir(join(root, 'fastmail-existing')), []);
  await symlink(root, join(root, 'alias')); await assert.rejects(saveOriginal(join(root, 'alias'), 'Same.docx', bytes, proof, () => {}), e => e.category === 'storage_refused');
}));
test('local readback mismatch and late revocation clean partial output', () => temp(async root => {
  const bytes = Buffer.from('original');
  await assert.rejects(saveOriginal(root, 'Same.docx', bytes, { sha256: '0'.repeat(64) }, () => {}), e => e.category === 'readback_failed'); assert.deepEqual(await readdir(root), []);
  let checks = 0; await assert.rejects(saveOriginal(root, 'Same.docx', bytes, { sha256: sha(bytes) }, () => { if (++checks === 3) throw new Error('private-content-sentinel'); }), e => e.category === 'storage_refused');
  assert.deepEqual(await readdir(root), []);
}));
