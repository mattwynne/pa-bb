import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocsAdapter } from '../adapters/docs.mjs';
import { createDocsCreationAdapter } from '../adapters/docs-create.mjs';
import { docsErrorMessage, docsFailureCategory } from '../core/docs-edit.mjs';
import { creationErrorMessage, creationFailureCategory } from '../core/docs-create.mjs';
import { failureCategory } from '../diagnostic.mjs';
import { record, input } from './docs-fixtures.mjs';
const policies = [
  { name: 'replacement', make: createDocsAdapter, prepare: adapter => adapter.prepareWrite(record),
    write: (writer, signal) => writer.replace({ ...input, documentId: 'doc-a' }, signal),
    read: adapter => adapter.inspect(record, 'doc-a'), marker: 'docsWriteAttempted', scopeCode: 'docsCode' },
  { name: 'creation', make: createDocsCreationAdapter, prepare: adapter => adapter.prepare(record),
    write: (writer, signal) => writer.create({ title: 'private-title', folderId: 'folder-a', operationId: 'private-operation' }, signal),
    read: adapter => adapter.find(record, 'fixture-operation'), marker: 'creationWriteAttempted', scopeCode: 'creationCode' },
  { name: 'population', make: createDocsCreationAdapter, prepare: adapter => adapter.prepare(record),
    write: (writer, signal) => writer.populate({ documentId: 'doc-a', tabId: 'tab-a', revisionId: 'rev-a', text: 'private-text' }, signal),
    read: adapter => adapter.find(record, 'fixture-operation'), marker: 'creationWriteAttempted', scopeCode: 'creationCode' },
];
function setup(policy, options = {}) {
  const calls = []; let identityChecks = 0, grantChecks = 0;
  const adapter = policy.make({
    verifiedAccess: async selected => {
      assert.equal(selected, record); identityChecks++;
      if (options.identityFailure && identityChecks > 1) throw new Error('private-identity-error');
      return `private-token-${identityChecks}`;
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.ok(init.signal instanceof AbortSignal);
      if (String(url).endsWith('/tokeninfo')) {
        grantChecks++;
        assert.equal(init.method, 'POST');
        assert.equal(new URLSearchParams(init.body).get('access_token'), `private-token-${identityChecks}`);
        if (grantChecks > 1 && options.grantFailure) return options.grantFailure();
        return Response.json({ scope: `https://www.googleapis.com/auth/${grantChecks > 1 ? options.nextScope || options.scope || 'drive.file' : options.scope || 'drive.file'}` });
      }
      assert.equal(init.headers.authorization, `Bearer private-token-${identityChecks}`);
      if (options.request) return options.request(init);
      return Response.json({ private: 'private-provider-body' }, { status: options.status || 200 });
    },
  });
  return { adapter, calls, identityChecks: () => identityChecks, grantChecks: () => grantChecks,
    writes: () => calls.filter(c => c.init.method === 'POST' && !c.url.endsWith('/tokeninfo')) };
}
function safeDiagnostic(error) {
  const diagnostic = [docsFailureCategory(error), creationFailureCategory(error), failureCategory(error), docsErrorMessage(error), creationErrorMessage(error)].join(' ');
  assert.doesNotMatch(diagnostic, /private-|writer@example|subject-a/);
  return diagnostic;
}
test('both writers share exact scope checking but Docs-only grants still authorize replacement, never creation/population', async () => {
  for (const policy of policies) for (const scope of ['drive', 'drive.file', 'documents', 'drive.readonly', 'documents.readonly']) {
    const h = setup(policy, { scope });
    const allowed = ['drive', 'drive.file'].includes(scope) || (scope === 'documents' && policy.name === 'replacement');
    if (allowed) {
      const writer = await policy.prepare(h.adapter);
      await policy.write(writer);
      assert.equal(h.writes().length, 1); assert.equal(h.identityChecks(), 2); assert.equal(h.grantChecks(), 2);
    } else {
      await assert.rejects(() => policy.prepare(h.adapter), error => {
        assert.equal(error[policy.scopeCode], 'scope_required'); safeDiagnostic(error); return true;
      });
      assert.equal(h.writes().length, 0);
    }
  }
});
test('fresh identity and grant checks stop every kind of write before submission when authorization changes', async () => {
  const failures = [
    { identityFailure: true }, { nextScope: 'drive.readonly' },
    { grantFailure: () => Response.json({ message: 'private-provider-body' }, { status: 401 }) },
    { grantFailure: () => Response.json({ message: 'private-provider-body' }, { status: 503 }) },
    { grantFailure: () => new Response('private-malformed-grant') },
    { grantFailure: () => new Response('{}', { headers: { 'content-length': '2000000' } }) },
  ];
  for (const policy of policies) for (const failure of failures) {
    const h = setup(policy, failure); const writer = await policy.prepare(h.adapter);
    await assert.rejects(() => policy.write(writer), error => {
      assert.equal(error[policy.marker], false); safeDiagnostic(error); return true;
    });
    assert.equal(h.writes().length, 0); assert.equal(h.identityChecks(), 2);
  }
});
test('submitted errors retain each operation’s rejection contract without retries or false no-attempt markers', async () => {
  for (const policy of policies) for (const status of [400, 401, 403, 404, 408, 429, 503]) {
    const h = setup(policy, { status }); const writer = await policy.prepare(h.adapter);
    await assert.rejects(() => policy.write(writer), error => {
      assert.equal(error.status, status); assert.equal(error[policy.marker], undefined);
      assert.equal(error.docsCode, [401, 403, 404].includes(status) ? 'authorization_failed'
        : status === 400 && policy.name === 'replacement' ? 'write_rejected' : 'remote_unavailable');
      assert.equal(error.creationRejected, policy.name !== 'replacement' && [400, 401, 403, 404].includes(status) ? true : undefined);
      assert.match(safeDiagnostic(error), new RegExp(`http_status=${status}`)); return true;
    });
    assert.equal(h.writes().length, 1); assert.equal(h.grantChecks(), 2);
  }
});
test('pre-submission cancellation differs from abort/timeout, lost replies and unreadable responses after submission', async () => {
  for (const policy of policies) {
    const h = setup(policy); const writer = await policy.prepare(h.adapter);
    const controller = new AbortController(); controller.abort(new Error('private-caller-abort'));
    await assert.rejects(() => policy.write(writer, controller.signal), error => {
      assert.equal(error[policy.marker], false); safeDiagnostic(error); return true;
    });
    assert.equal(h.writes().length, 0);
    for (const request of [
      () => { throw Object.assign(new Error('private-lost-reply'), { cause: 'private-cause', code: 'private-code' }); },
      () => { throw new DOMException('private-timeout', 'TimeoutError'); },
      () => new Response('private-malformed-write-response'),
      () => new Response('{}', { headers: { 'content-length': '2000000' } }),
      init => { init.signal.throwIfAborted(); return new Response('private-response'); },
    ]) {
      const c = new AbortController();
      const f = setup(policy, { request: init => {
        c.abort(new Error('private-in-flight-abort'));
        assert.equal(init.signal.aborted, true);
        return request(init);
      } });
      const w = await policy.prepare(f.adapter);
      await assert.rejects(() => policy.write(w, c.signal), error => {
        assert.equal(error[policy.marker], undefined); assert.equal(error.creationRejected, undefined); safeDiagnostic(error); return true;
      });
      assert.equal(f.writes().length, 1);
    }
  }
});
test('shared reads enforce bounded responses and do not expose HTTP error bodies', async () => {
  for (const policy of policies.slice(0, 2)) for (const request of [
    () => new Response('x'.repeat(1_048_577)),
    () => new Response('{}', { headers: { 'content-length': '2000000' } }),
    () => new Response(null),
    () => new Response('private-malformed-read'),
    () => Response.json({ message: 'private-provider-body' }, { status: 403 }),
  ]) {
    const h = setup(policy, { request });
    await assert.rejects(() => policy.read(h.adapter), error => { safeDiagnostic(error); return true; });
    assert.equal(h.calls.length, 1); assert.equal(h.writes().length, 0);
  }
});
test('core-facing adapters still expose only narrow document operations, not arbitrary HTTP requests', async () => {
  for (const policy of policies.slice(0, 2)) {
    const h = setup(policy);
    assert.deepEqual(Object.keys(h.adapter).sort(), policy.name === 'replacement' ? ['inspect', 'prepareWrite'] : ['find', 'prepare']);
    const writer = await policy.prepare(h.adapter);
    assert.deepEqual(Object.keys(writer).sort(), policy.name === 'replacement' ? ['replace'] : ['create', 'populate']);
  }
});
