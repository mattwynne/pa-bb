import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocsEditService, inspectDocument, docsError, docsErrorMessage, docsFailureCategory } from '../core/docs-edit.mjs';
import { account, record, input, document, tab } from './docs-fixtures.mjs';
function setup(options = {}) {
  let doc = document();
  let writes = 0, approvals = 0, scopes = 0;
  const logs = [];
  const service = createDocsEditService({
    store: { byEmail: async email => email === account ? record : null },
    drive: { getFile: async () => ({ id: 'doc-a', trashed: false, mimeType: 'application/vnd.google-apps.document', ...options.metadata }) },
    docs: { inspect: async () => { if (writes && options.readbackError) throw new Error('private-readback-body-and-token'); return structuredClone(doc); }, prepareWrite: async () => {
      scopes++;
      if (options.scopeError) throw docsError('scope_required');
      return { replace: async proposal => {
        writes++;
        if (options.writeError) throw options.writeError;
        doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content = doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content.replace(proposal.oldText, proposal.newText);
        const content = doc.tabs[0].documentTab.body.content[1];
        content.endIndex = content.paragraph.elements[0].endIndex = 1 + content.paragraph.elements[0].textRun.content.length;
        doc.revisionId = 'rev-b';
        if (options.after) options.after(doc);
        return { documentId: 'doc-a', replies: [{ replaceAllText: { occurrencesChanged: options.count ?? 1 } }], writeControl: { requiredRevisionId: 'rev-b' } };
      } };
    } },
    approve: async proposal => { approvals++; options.onApprove?.(doc, proposal); return Object.hasOwn(options, 'approved') ? options.approved : true; },
    diagnose: (stage, error) => logs.push(`${stage} ${docsFailureCategory(error)}`),
  });
  return { service, set: next => { doc = next; }, stats: () => ({ writes, approvals, scopes }), logs };
}
const failure = code => error => error.docsCode === code;
test('complete inspection exposes exact tabs, UTF-16 text and account revision without internal run metadata', async () => {
  const { service } = setup();
  const result = await service.inspect({ account, document: 'https://docs.google.com/document/d/doc-a/edit?tab=tab-a' });
  assert.equal(result.complete, true);
  assert.equal(result.revisionId, 'rev-a');
  assert.equal(result.tabs[0].text, 'Hello 😀 old words.\n');
  assert.equal(result.tabs[0].runs, undefined);
  assert.ok(JSON.stringify(result).length < 1000);
});
test('preview defaults to no write, no owner form, no write-scope requirement', async () => {
  const { service, stats } = setup({ scopeError: true });
  const result = await service.replace(input);
  assert.equal(result.outcome, 'preview');
  assert.equal(result.writeAuthorization, 'not_checked');
  assert.equal(result.proposal.oldText, input.oldText);
  assert.equal(result.proposal.newText, input.newText);
  assert.deepEqual(stats(), { writes: 0, approvals: 0, scopes: 0 });
});
test('one owner-approved literal replacement verifies all tab text, including nested tabs', async () => {
  const { service, stats, set } = setup();
  const doc = document(); doc.tabs[0].childTabs = [tab('Other content.\n', 'tab-child')]; set(doc);
  const result = await service.replace({ ...input, preview: false });
  assert.equal(result.outcome, 'verified');
  assert.equal(result.revisionId, 'rev-b');
  assert.equal(result.verification.includes('Formatting is not independently verified'), true);
  assert.deepEqual(stats(), { writes: 1, approvals: 1, scopes: 1 });
});
test('deleting matched text is supported, but paragraph boundaries cannot be deleted', async () => {
  const { service } = setup();
  assert.equal((await service.replace({ ...input, newText: '', preview: false })).outcome, 'verified');
  await assert.rejects(() => setup().service.replace({ ...input, oldText: 'old words.\n' }), failure('invalid_input'));
});
test('stale before approval or collaborator changes during approval fail closed', async () => {
  let h = setup();
  await assert.rejects(() => h.service.replace({ ...input, expectedRevisionId: 'rev-other', preview: false }), failure('stale_revision'));
  assert.equal(h.stats().approvals, 0);
  h = setup({ onApprove: doc => { doc.revisionId = 'collaborator-revision'; } });
  await assert.rejects(() => h.service.replace({ ...input, preview: false }), failure('stale_revision'));
  assert.equal(h.stats().writes, 0);
});
test('zero, multiple, overlapping and cross-run matches are rejected', async () => {
  for (const text of ['Missing.\n', 'old words old words\n', 'aaaa\n']) {
    const h = setup(); h.set(document(text));
    await assert.rejects(() => h.service.replace({ ...input, oldText: text === 'aaaa\n' ? 'aa' : input.oldText, preview: false }), failure('match_not_unique'));
    assert.equal(h.stats().writes, 0);
  }
  const h = setup(); const doc = document('old words\n');
  doc.tabs[0].documentTab.body.content[1].paragraph.elements = [
    { startIndex: 1, endIndex: 5, textRun: { content: 'old ' } },
    { startIndex: 5, endIndex: 11, textRun: { content: 'words\n', textStyle: { italic: true } } },
  ]; h.set(doc);
  await assert.rejects(() => h.service.replace(input), failure('match_not_unique'));
});
test('partial, oversized, unsupported, suggested and malformed documents/tabs fail closed', async () => {
  const cases = [
    doc => { delete doc.tabs; }, doc => { doc.tabs = []; }, doc => { delete doc.revisionId; },
    doc => { doc.documentId = 'another-doc'; }, doc => { doc.suggestionsViewMode = 'PREVIEW_WITHOUT_SUGGESTIONS'; },
    doc => { doc.tabs.push(tab('Other\n')); }, doc => { doc.tabs.push({ tabProperties: { tabId: 'unknown' } }); },
    doc => { delete doc.tabs[0].documentTab.body.content[1].paragraph.elements; },
    doc => { doc.tabs[0].documentTab.body.content[1].endIndex++; },
    doc => { doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].startIndex++; },
    doc => { doc.tabs[0].documentTab.body.content.push({ startIndex: 21, endIndex: 22, table: {} }); },
    doc => { doc.tabs[0].documentTab.headers = { h: { content: [] } }; },
    doc => { doc.tabs[0].documentTab.footnotes = { f: {} }; },
    doc => { doc.tabs[0].documentTab.futureContent = { text: 'private-unknown-content' }; },
    doc => { doc.tabs[0].documentTab.body.content[1].unknownStructure = {}; },
    doc => { doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.suggestedInsertionIds = ['private-suggestion']; },
    doc => { doc.tabs[0].childTabs = [tab('Unsupported\n', 'child')]; doc.tabs[0].childTabs[0].documentTab.body.content[1].paragraph.elements[0] = { startIndex: 1, endIndex: 2, richLink: {} }; },
    doc => { doc.tabs[0] = tab('x'.repeat(50_001) + '\n'); },
  ];
  for (const mutate of cases) {
    const h = setup(); const doc = document(); mutate(doc); h.set(doc);
    await assert.rejects(() => h.service.replace({ ...input, preview: false }), failure('unsupported_document'));
    assert.equal(h.stats().writes, 0);
  }
});
test('wrong account/type, permissions and missing scopes never request owner approval or write', async () => {
  const h = setup({ scopeError: true });
  await assert.rejects(() => h.service.replace({ ...input, account: 'wrong@example.test', preview: false }), failure('unknown_account'));
  await assert.rejects(() => setup({ metadata: { mimeType: 'application/pdf' } }).service.replace(input), failure('wrong_type'));
  await assert.rejects(() => setup({ metadata: { trashed: true } }).service.replace(input), failure('wrong_type'));
  await assert.rejects(() => setup({ metadata: { trashed: undefined } }).service.replace(input), failure('wrong_type'));
  await assert.rejects(() => h.service.replace({ ...input, preview: false }), failure('scope_required'));
  assert.deepEqual(h.stats(), { writes: 0, approvals: 0, scopes: 1 });
});
test('declined, cancelled, aborted and malformed approvals never write', async () => {
  for (const approved of [false, null, 'true', { approved: true }]) {
    const h = setup({ approved });
    assert.equal((await h.service.replace({ ...input, preview: false })).outcome, 'cancelled');
    assert.equal(h.stats().writes, 0);
  }
  const controller = new AbortController();
  const h = setup({ onApprove: () => controller.abort() });
  assert.equal((await h.service.replace({ ...input, preview: false }, controller.signal)).outcome, 'cancelled');
  assert.equal(h.stats().writes, 0);
});
test('write rejection differs from uncertain transport, and writes are never replayed', async () => {
  for (const code of ['authorization_failed', 'write_rejected']) {
    const h = setup({ writeError: docsError(code) });
    await assert.rejects(() => h.service.replace({ ...input, preview: false }), failure(code));
    assert.equal(h.stats().writes, 1);
  }
  const h = setup({ writeError: Object.assign(new Error('private-body-secret'), { cause: 'private-token' }) });
  const result = await h.service.replace({ ...input, preview: false });
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.retrySafe, false); assert.equal(h.stats().writes, 1);
  assert.doesNotMatch(JSON.stringify([result, h.logs]), /private-body|private-token/);
});
test('incorrect occurrence count, changed sibling tab or post-write collaborator revision cannot be verified', async () => {
  for (const options of [{ readbackError: true }, { count: 0 }, { count: 2 }, { after: doc => { doc.revisionId = 'rev-concurrent'; } }, { after: doc => { doc.tabs.push(tab('Concurrent.\n', 'new-tab')); } }]) {
    const h = setup(options);
    assert.equal((await h.service.replace({ ...input, preview: false })).outcome, 'verification_unavailable');
    assert.equal(h.stats().writes, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /private-readback|body-and-token/);
  }
});
test('bounded inputs, valid URLs, literal non-ASCII matching and redacted diagnostics', async () => {
  for (const change of [{ oldText: '' }, { newText: '\ud800' }, { newText: 'x'.repeat(2001) }, { newText: 'new\nparagraph' }, { newText: '\u0000' }, { preview: 'false' }, { document: 'https://docs.google.com.evil.test/document/d/doc-a' }, { document: 'https://user:pass@docs.google.com/document/d/doc-a' }]) {
    await assert.rejects(() => setup().service.replace({ ...input, ...change }));
  }
  const h = setup();
  assert.equal((await h.service.replace({ ...input, oldText: '😀', newText: '👩🏽‍💻', preview: false })).outcome, 'verified');
  assert.doesNotMatch(docsErrorMessage(new Error('private-provider-content')), /private/);
  assert.equal(docsFailureCategory({ code: 'private-code', docsCode: 'private-body' }), 'unknown');
  assert.equal(inspectDocument(document(), 'doc-a').tabs[0].runs[0].offset, 0);
});
