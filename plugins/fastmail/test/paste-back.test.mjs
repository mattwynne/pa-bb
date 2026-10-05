import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('paste-back renders a password input without displaying callback code in prose', async () => {
  const source = await readFile(resolve('paste-back.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
  const temporary = resolve('paste-back.ui-test.generated.mjs');
  const shared = resolve('connection-ui.js');
  const sharedSource = await readFile(resolve('connection-ui.tsx'), 'utf8');
  const sharedCompiled = ts.transpileModule(sharedSource, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
  try {
    await writeFile(shared, sharedCompiled);
    await writeFile(temporary, compiled);
    const { PasteBack } = await import(`file://${temporary}`);
    const secret = 'http://localhost:38886/?code=synthetic-private-code';
    const markup = renderToStaticMarkup(createElement(PasteBack, { callback: secret, busy: false, onChange() {}, onSubmit() {} }));
    assert.match(markup, /type="password"/);
    assert.match(markup, /Complete connection/);
    assert.equal(markup.split('synthetic-private-code').length - 1, 1); // only in the controlled input value
    assert.doesNotMatch(markup.replace(/<input\b[^>]*>/g, ''), /synthetic-private-code/);
  } finally { await unlink(temporary).catch(() => {}); await unlink(shared).catch(() => {}); }
});
