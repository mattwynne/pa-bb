// Preserve native function sources through BB/esbuild, which may inject closure-bound helpers into functions.
import { readFile, writeFile } from 'node:fs/promises';
import { browserCapture } from '../bank-rec/browser/capture.mjs';
import { extractVisibleStatementLines } from '../bank-rec/browser/statement-lines.mjs';
const content = JSON.stringify({ capture: browserCapture.toString(), extract: extractVisibleStatementLines.toString() }, null, 2) + '\n';
const path = new URL('../bank-rec/browser-source.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== content) throw new Error('Bank Rec browser source drift. Run npm run bookmarklet:update.');
} else await writeFile(path, content);
