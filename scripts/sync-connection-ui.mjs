import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['connection-ui.tsx', 'connection-ui.css'];
const plugins = ['google-calendar', 'fastmail', 'google-drive'];
const check = process.argv.includes('--check');
let drift = false;
for (const file of files) {
  const source = await readFile(resolve(root, 'shared/connection-ui', file), 'utf8');
  const content = `/* Generated from shared/connection-ui/${file}. Do not edit this copy. */\n${source}`;
  for (const plugin of plugins) {
    const target = resolve(root, 'plugins', plugin, file);
    if (check) {
      let existing;
      try { existing = await readFile(target, 'utf8'); } catch { existing = ''; }
      if (existing !== content) { console.error(`Out of sync: ${target}`); drift = true; }
    } else {
      await writeFile(target, content);
      console.log(`Updated ${target}`);
    }
  }
}
if (drift) process.exitCode = 1;
