import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('shared connection UI renders the account, status, actions and recovery affordances', async () => {
  const source = await readFile(resolve('connection-ui.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
  const temporary = resolve('test/connection-ui.ui-test.generated.mjs');
  try {
    await writeFile(temporary, compiled);
    const ui = await import(`file://${temporary}`);
    const button = createElement(ui.ConnectionButton, { 'aria-label': 'Remove account', disabled: true }, 'Remove');
    const row = renderToStaticMarkup(createElement(ui.ConnectionAccounts, null,
      createElement(ui.ConnectionAccount, { initial: 'E', label: 'example@example.test', status: 'Connected', action: button })));
    assert.match(row, /pa-connection__accounts/);
    assert.match(row, /pa-connection__badge/);
    assert.match(row, /example@example\.test/);
    assert.match(row, /disabled=""/);
    assert.match(row, /aria-label="Remove account"/);
    const heading = renderToStaticMarkup(createElement(ui.ConnectionHeading, { title: 'Connected accounts', count: 1 }));
    assert.match(heading, /<h3[^>]*>Connected accounts/);
    assert.match(heading, /pa-connection__count">1/);
    assert.match(renderToStaticMarkup(createElement(ui.ConnectionAlert, null, 'Try again')), /role="alert"/);
  } finally { await unlink(temporary).catch(() => {}); }
});
