// Opt-in desktop comparison. Ordinary plugin tests use synthetic vault files only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

if (process.argv.length !== 4) throw new Error('Usage: node obsidian-desktop-fixture.mjs DESKTOP_BINARY VERIFIED_ASAR');
const [binary, asar] = process.argv.slice(2).map(value => resolve(value));
const digest = createHash('sha256').update(await readFile(asar)).digest('hex');
assert.equal(digest, '42bf7f34782752f159d63c17ac6bac4ad01dd55709578f9879f76f8295abb2eb');
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const { port } = probe.address();
await new Promise(done => probe.close(done));

const fixture = await mkdtemp(join(tmpdir(), 'pa-obsidian-link-fixture-'));
const vault = join(fixture, 'vault');
const config = join(fixture, 'config', 'obsidian');
let desktop, socket;
try {
  await mkdir(config, { recursive: true });
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await writeFile(join(config, 'obsidian.json'), JSON.stringify({ vaults: { fixture: { path: vault, ts: 1, open: true } } }));
  await copyFile(asar, join(config, 'obsidian-1.15.1.asar'));
  const journal = 'Journal/Nested/Entry.md';
  const project = 'Projects/Pilot/README.md';
  const moved = 'Projects/Archive/README.md';
  const external = '[external](file:///tmp/external/README.md)';
  for (const path of ['README.md', project, 'Copy/Projects/Pilot/README.md', 'Alpha/Tie.md', 'Bravo/Tie.md',
    'Alpha/Guide.md', 'Projects/Pilot/Guide.md', 'Longer/Unique.md', 'A/Unique.md']) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), '# Fixture\n');
  }
  await mkdir(join(vault, 'Projects/Archive'));
  await mkdir(dirname(join(vault, journal)), { recursive: true });
  await writeFile(join(vault, journal), `[[README]]\n[[Projects/Pilot/README]]\n[[Tie]]\n[[Projects/Archive/README]]\n${external}\n`);
  desktop = spawn(binary, ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless',
    `--remote-debugging-port=${port}`], {
    env: { ...process.env, XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'data'), XDG_CACHE_HOME: join(fixture, 'cache') },
    stdio: 'ignore',
  });
  const until = async fn => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await fn();
      if (result) return result;
      await wait(200);
    }
    throw new Error('Timed out waiting for the disposable Obsidian fixture');
  };
  const page = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return pages.find(page => page.type === 'page');
    } catch { return undefined; }
  });
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  const evaluate = async expression => {
    const response = new Promise(done => {
      const receive = event => {
        const frame = JSON.parse(event.data);
        if (frame.id === 1) {
          socket.removeEventListener('message', receive);
          done(frame);
        }
      };
      socket.addEventListener('message', receive);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    const frame = await response;
    if (frame.result?.exceptionDetails) throw new Error(frame.result.exceptionDetails.exception?.description ?? 'Desktop evaluation failed');
    return frame.result.result.value;
  };
  const path = JSON.stringify(journal);
  await until(() => evaluate(`Boolean(globalThis.app?.metadataCache?.resolvedLinks?.[${path}])`));
  const before = await evaluate(`(() => {
    const paths = (link, source = ${path}) => app.metadataCache.getLinkpathDest(link, source).map(file => file.path);
    return {
      root: paths('README'), exact: paths('Projects/Pilot/README'), relative: paths('./README', ${JSON.stringify(project)}),
      near: paths('Guide', ${JSON.stringify(project)}), shortest: paths('Unique'), tied: paths('Tie'),
      suffix: paths('Pilot/README'), missing: paths('Projects/Archive/README'),
      nativeBacklinks: app.metadataCache.resolvedLinks[${path}],
    };
  })()`);
  assert.deepEqual(before.root, ['README.md']);
  assert.deepEqual(before.exact, [project]);
  assert.deepEqual(before.relative, [project]);
  assert.deepEqual(before.near, ['Projects/Pilot/Guide.md', 'Alpha/Guide.md']);
  assert.deepEqual(before.shortest, ['A/Unique.md', 'Longer/Unique.md']);
  assert.deepEqual(before.tied.sort(), ['Alpha/Tie.md', 'Bravo/Tie.md']);
  assert.deepEqual(before.suffix, [project, 'Copy/Projects/Pilot/README.md']);
  assert.deepEqual(before.missing, []);
  assert.equal(before.nativeBacklinks['README.md'], 1);
  assert.equal(before.nativeBacklinks[project], 1);
  await evaluate(`(async () => {
    app.vault.setConfig('alwaysUpdateLinks', true);
    await app.fileManager.renameFile(app.vault.getFileByPath(${JSON.stringify(project)}), ${JSON.stringify(moved)});
  })()`);
  const after = await readFile(join(vault, journal), 'utf8');
  assert.equal(after, `[[README]]\n[[Projects/Archive/README]]\n[[Tie]]\n[[Projects/Archive/README]]\n${external}\n`);
  console.log(JSON.stringify({ release: '1.15.1', before, after }, null, 2));
} finally {
  socket?.close();
  if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
    const stopped = once(desktop, 'exit');
    desktop.kill();
    await stopped;
  }
  await rm(fixture, { recursive: true, force: true });
}
