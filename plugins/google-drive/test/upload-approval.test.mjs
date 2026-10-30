import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const component = new URL('./upload-approval.generated.mjs', import.meta.url), connection = new URL('./upload-connection.generated.mjs', import.meta.url);
const compile = text => ts.transpileModule(text, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
await writeFile(connection, compile(await readFile(new URL('../connection-ui.tsx', import.meta.url), 'utf8')));
await writeFile(component, compile((await readFile(new URL('../upload-approval.tsx', import.meta.url), 'utf8')).replace('./connection-ui.js', './upload-connection.generated.mjs')));
const { UploadApproval } = await import('./upload-approval.generated.mjs');
test.after(async () => { await unlink(component); await unlink(connection); });
const payload = { account: 'owner@example.invalid', operationId: '11111111-1111-4111-8111-111111111111', destinationId: 'folder', path: 'My Drive / Team', owners: 'foreign@example.invalid', audience: 'team@example.invalid — Can edit', title: 'Synthetic <script>', mimeType: 'application/test', sourceHost: 'BB server', sourcePath: '/synthetic/model.xlsx', sourceName: 'model.xlsx', size: '123', sha256: 'a'.repeat(64), mode: 'binary', conversion: 'No conversion' };
const render = p => renderToStaticMarkup(createElement(UploadApproval, { interaction: { id: 'synthetic', payload: p }, submit: async () => {}, cancel: async () => {} }));
test('upload approval discloses exact source/version, exposure, no rendered content and mode', () => {
  const html = render(payload);
  for (const text of ['BB server', '/synthetic/model.xlsx', '123', 'a'.repeat(64), 'team@example.invalid', 'not rendered', 'No conversion', 'Approve upload', 'Decline', 'Cancel review', '&lt;script&gt;']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/);
  const imported = render({ ...payload, mode: 'xlsx_to_sheet' });
  for (const text of ['Approve import', 'not byte-preserving', '1,000 cells', 'full Excel fidelity']) assert.ok(imported.includes(text));
});
test('missing/malformed exact review fields cannot approve', () => {
  for (const key of Object.keys(payload)) assert.match(render({ ...payload, [key]: '' }), /disabled=""[^>]*>Approve upload/);
  for (const change of [{ mode: 'unexpected' }, { size: '4194305' }, { sha256: 'wrong' }]) assert.match(render({ ...payload, ...change }), /disabled=""[^>]*>Approve upload/);
});
