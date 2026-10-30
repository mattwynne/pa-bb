// Synthetic SSR only; native BB desktop/narrow/keyboard review is a separate gate.
// While canonical artifacts are held for review, run this in the disposable copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const componentFile = new URL('./filing-approval.generated.mjs', import.meta.url);
const connectionFile = new URL('./filing-connection.generated.mjs', import.meta.url);
const compile = text => ts.transpileModule(text, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
await writeFile(connectionFile, compile(await readFile(new URL('../connection-ui.tsx', import.meta.url), 'utf8')));
await writeFile(componentFile, compile((await readFile(new URL('../filing-approval.tsx', import.meta.url), 'utf8')).replace('./connection-ui.js', './filing-connection.generated.mjs').replaceAll("'./core/", "'../core/")));
const { FilingApproval } = await import('./filing-approval.generated.mjs');
test.after(async () => { await unlink(componentFile); await unlink(connectionFile); });
const payload = { kind: 'move', account: 'owner@example.invalid', operationId: '11111111-1111-4111-8111-111111111111', fileId: 'doc-id', destinationId: 'dest-id',
  title: 'Synthetic <script>bad</script>', from: 'My Drive', to: 'My Drive / Team', sourceAudience: 'Owner only in current listing', destinationAudience: 'group: team@example.invalid — writer', audience: 'group: team@example.invalid — writer', impact: 'Inherited access may change.' };
const render = p => renderToStaticMarkup(createElement(FilingApproval, { interaction: { id: 'synthetic', payload: p }, submit: async () => {}, cancel: async () => {} }));
test('filing card shows exact account/location/audience and no-content/no-permission-change limits', () => {
  const html = render(payload);
  for (const text of ['owner@example.invalid', 'My Drive / Team', 'team@example.invalid', 'Inherited access may change', 'No write has happened', 'Approve filing', 'Decline', 'Cancel review', 'rechecked before submission', 'no automatic rollback']) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /https:\/\/drive.google.com\/drive\/folders\/dest-id/);
  assert.match(html, /https:\/\/docs.google.com\/document\/d\/doc-id\/edit/);
});
test('shared-ancestor review shows exact path owners and potential gains/losses; incomplete owner evidence cannot be approved', () => {
  const shared = { ...payload, sharedAncestors: true, sourceOwners: 'My Drive — owner: owner@example.invalid',
    destinationOwners: 'Shared <administration> — owner: partner@example.invalid',
    accessChanges: 'user: partner@example.invalid — may gain/increase to writer\nuser: old@example.invalid — may lose/reduce inherited reader access',
    reviewReason: 'An inspected ancestor belongs to another person. Exact owner approval is required even if visible audiences appear equivalent.' };
  const html = render(shared);
  for (const text of ['Current path owners', 'Destination path owners', 'Who may gain or lose access', 'partner@example.invalid', 'old@example.invalid', 'may gain/increase', 'may lose/reduce', 'even if visible audiences appear equivalent']) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('Who may gain or lose access') < html.indexOf('<details>'));
  assert.ok(html.indexOf('may gain/increase') < html.indexOf('<details>'));
  assert.ok(html.indexOf('Full access and folder details') < html.indexOf('Current path owners'));
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /Shared &lt;administration&gt;/);
  for (const field of ['sourceOwners', 'destinationOwners', 'accessChanges', 'reviewReason']) {
    assert.match(render({ ...shared, [field]: '' }), /disabled=""[^>]*>Approve filing/);
  }
});
test('native and binary cards use file labels, escaped MIME and canonical links, never provider URLs', () => {
  for (const [mimeType, url] of [
    ['application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/doc-id/edit'],
    ['application/vnd.google-apps.presentation', 'https://docs.google.com/presentation/d/doc-id/edit'],
    ['application/pdf', 'https://drive.google.com/file/d/doc-id/view'],
    ['application/x-next-file-type', 'https://drive.google.com/file/d/doc-id/view'],
    ['<script>private-bad</script>', 'https://drive.google.com/file/d/doc-id/view'],
  ]) {
    const html = render({ ...payload, mimeType, url: 'javascript:private-bad' });
    for (const text of ['Move existing file:', 'Open existing file', 'File ID', 'File type', url]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /<script>|javascript:|Move existing document/);
  }
});
test('plain file labels keep exact metadata in collapsed details and legacy payloads remain reviewable', () => {
  const html = render({ ...payload, mimeType: 'application/vnd.google-apps.spreadsheet', sharedAncestors: true,
    sourceOwners: 'Root — owner: owner@example.invalid', destinationOwners: 'Shared — owner: partner@example.invalid',
    sharedAncestorSummary: '“Shared <folder>” belongs to partner@example.invalid.',
    accessChanges: 'partner@example.invalid — may gain access: Can edit', reviewReason: 'A parent folder belongs to another person.' });
  for (const text of ['Google Sheet', 'Technical file type', 'Existing direct shares stay unchanged', 'Access through folders may change', 'Ownership, contents, file ID and link stay the same', 'Only a verified tool result confirms completion', 'role="status"', 'aria-live="polite"']) assert.ok(html.includes(text), text);
  assert.match(html, /Shared &lt;folder&gt;/);
  assert.ok(html.indexOf('belongs to partner') < html.indexOf('<details>'));
  assert.ok(html.indexOf('application/vnd.google-apps.spreadsheet') > html.indexOf('<details>'));
  assert.doesNotMatch(render(payload), /disabled=""[^>]*>Approve filing/);
});
test('task explains approval-free empty-folder inheritance separately from moved-file access', () => {
  const html = render({ kind: 'task', account: payload.account, operationId: payload.operationId,
    items: [{ ...payload, kind: 'folder', title: 'Empty shared folder', accessChanges: 'Inherited destination audience.', requiresApproval: false },
      { ...payload, kind: 'move', accessChanges: 'Partner may gain access.', requiresApproval: true }] });
  assert.match(html, /Empty folder inherits the selected destination/);
  assert.match(html, /no existing document is disclosed/);
  assert.match(html, /Later file moves are evaluated separately/);
});
test('legacy foreign-parent folder card leads with exact name, creator ownership and visible parent audience; no source loss or transfer claim', () => {
  const html = render({ ...payload, kind: 'folder', title: 'Synthetic - exact folder', mimeType: 'application/vnd.google-apps.folder',
    from: 'New folder', to: 'My Drive / Shared / Synthetic - exact folder', sharedAncestors: true,
    sourceOwners: 'New folder — no existing path.', destinationOwners: 'Shared — owner: partner@example.invalid',
    sharedAncestorSummary: '“Shared” belongs to partner@example.invalid.',
    accessChanges: 'partner@example.invalid — may get access through the destination folder (parent access: Owner).',
    reviewReason: 'A parent folder belongs to another person.' });
  for (const text of ['Create folder: ', 'Synthetic - exact folder', 'Creator and new folder owner: ', 'owner@example.invalid', 'parent ownership stays unchanged', 'partner@example.invalid', 'may get access', 'parent access: Owner', 'No write has happened']) {
    assert.ok(html.indexOf(text) >= 0 && html.indexOf(text) < html.indexOf('<details>'), text);
  }
  assert.doesNotMatch(html, /Open existing file|may lose some|Ownership, contents, file ID/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Approve filing/);
});
test('missing/invalid filing payload fails closed without links; synthetic preview has no live links', () => {
  for (const p of [null, {}, { ...payload, destinationId: 'javascript:bad' }, { ...payload, operationId: 'bad' }, { ...payload, fileId: '' }, { ...payload, account: '' }, { ...payload, kind: 'copy' }, { ...payload, audience: '' }]) {
    const html = render(p); assert.match(html, /details are incomplete/); assert.match(html, /disabled=""[^>]*>Approve filing/); assert.doesNotMatch(html, /href=/);
  }
  const html = render({ ...payload, exampleOnly: true }); assert.match(html, /all choices are no-ops/); assert.doesNotMatch(html, /href=/);
});
