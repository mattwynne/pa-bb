import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function stableVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  const parts = match?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : null;
}

export function supportsHost(actual, range) {
  const current = stableVersion(actual);
  const minimum = typeof range === 'string' && range.startsWith('>=') ? stableVersion(range.slice(2)) : null;
  if (!current || !minimum) return false;
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i];
  }
  return true;
}

async function verifyEmail() {
  const manifest = JSON.parse(await readFile(new URL('../plugins/email/package.json', import.meta.url), 'utf8'));
  const response = await fetch('http://127.0.0.1:38886/api/v1/system/version', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error();
  const host = await response.json();
  if (host.installKind !== 'npm' || !supportsHost(host.currentVersion, manifest.engines.bb)) throw new Error();

  // Use the real adapter without connecting providers or touching existing mail.
  const { MsgVault } = await import('../plugins/email/msgvault.ts');
  const root = await mkdtemp(join(tmpdir(), 'pa-bb-smoke-email-'));
  let diagnosed = false;
  const vault = new MsgVault(() => { diagnosed = true; });
  const signal = AbortSignal.timeout(60_000);
  let result;
  try {
    if (await vault.check(signal) !== 'ready') throw new Error();
    const folder = join(root, 'batch');
    const mailbox = join(folder, 'Archive.mailbox');
    await mkdir(mailbox, { recursive: true });
    await writeFile(join(mailbox, '1.eml'), [
      'From: Sender <sender@example.test>', 'To: Receiver <receiver@example.test>',
      'Date: Tue, 10 Nov 2026 11:22:33 +0000', 'Message-ID: <docker-smoke@example.test>',
      'Subject: Generated Docker archive', '', 'A generated orangepenguin message.', '',
    ].join('\r\n'));
    const first = join(root, 'account-a');
    const second = join(root, 'account-b');
    await vault.import(first, 'docker-smoke-a', folder, 1, signal);
    await vault.import(first, 'docker-smoke-a', folder, 1, signal);
    const found = await vault.search(first, 'from:sender@example.test orangepenguin', 5, signal);
    if (found.length !== 1 || found[0].subject !== 'Generated Docker archive') throw new Error();
    const isolated = await vault.search(second, 'orangepenguin', 5, signal);
    if (isolated.length !== 0) throw new Error();
    const message = await vault.read(first, found[0].id, signal);
    if (message.id !== found[0].id || message.subject !== 'Generated Docker archive' ||
        !message.body.includes('orangepenguin') || message.to[0]?.email !== 'receiver@example.test') throw new Error();
    result = { version: 1, available: true, messages: found.length, isolated: true, read: true };
  } finally {
    try { await vault.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
  if (diagnosed) throw new Error();
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEmail().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Generated email-archive verification failed.'); process.exitCode = 1;
  });
}
