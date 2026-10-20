import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

const USERNAME = 'synthetic-login@example.test';
const SECRET = 'synthetic-private-password';
const PRIVATE = 'PRIVATE-REMOTE-CONTENT';
const settings = { carddavUsername: USERNAME, carddavAppPassword: SECRET };
const args = { action: 'add', group: 'Feed', email: 'sender+articles@example.test' };
const home = `https://carddav.fastmail.com/dav/addressbooks/user/${encodeURIComponent(USERNAME)}/`;
const book = `${home}default/`;
const card = (lines) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join('\r\n');
const group = card(['UID:group-1', 'FN:Feed', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-KEEP:untouched', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:other-member']);
const person = card(['UID:contact-1', 'FN:Sender', `EMAIL:${args.email}`, 'EMAIL:second@example.test']);
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const xml = (rows) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">${rows.map(([url, text]) => `<d:response><d:href>${url}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop>${text === null ? '<d:resourcetype><c:addressbook/></d:resourcetype>' : `<c:address-data>${escape(text)}</c:address-data>`}</d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`;
const resolve = host => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
const call = (host, input = args) => host.harness.behavior.callAgentTool('fastmail_contact_groups', input);
const data = result => JSON.parse(result.content[0].text);

function fixture(options = {}) {
  let saved = group;
  let writes = 0;
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, ...init });
    if (init.signal.aborted) throw new Error(`${PRIVATE} aborted ${SECRET}`);
    assert.equal(init.redirect, 'manual');
    if (options.denied) return new Response(PRIVATE + SECRET, { status: 403 });
    if (init.method === 'PROPFIND') return new Response(xml([[book, null]]), { status: 207 });
    if (init.method === 'REPORT') return new Response(xml([[`${book}${init.body.includes('name="KIND"') ? 'group' : 'person'}.vcf`, init.body.includes('name="KIND"') ? saved : options.person ?? person]]), { status: 207 });
    if (init.method === 'GET') {
      if (writes && options.verificationFails) throw new Error(PRIVATE + SECRET);
      return new Response(saved, { status: 200, headers: { ETag: '"fresh"' } });
    }
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['If-Match'], '"fresh"');
    writes++;
    if (options.conflict) return new Response(PRIVATE + SECRET, { status: 412 });
    saved = init.body;
    if (options.uncertain) throw new Error(PRIVATE + SECRET);
    return new Response(null, { status: 204 });
  };
  return { fetcher, calls, writes: () => writes, saved: () => saved };
}

async function withHost(options, run) {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings });
  const fake = fixture(options);
  try { await plugin(host.bb, undefined, undefined, fake.fetcher); await run(host, fake); }
  finally { await host.harness.lifecycle.dispose(); }
}

test('CardDAV configuration is independent, secret, lazy, and read at each invocation', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const fake = fixture();
  try {
    await plugin(host.bb, undefined, undefined, fake.fetcher);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual((await resolve(host)).tools, []);
    for (const key of Object.keys(settings)) assert.equal(host.harness.inspection.registrations.settingsDescriptors[key].secret, true);
    await host.harness.behavior.setSettings({ carddavUsername: USERNAME });
    assert.deepEqual((await resolve(host)).tools, []);
    await host.harness.behavior.setSettings({ carddavAppPassword: SECRET });
    const selected = await resolve(host);
    assert.deepEqual(selected.tools.map(t => t.name), ['fastmail_contact_groups']);
    assert.match(selected.instructions, /Message labels do not change contact-group routing/);
    assert.doesNotMatch(JSON.stringify(selected), new RegExp(`${SECRET}|${USERNAME}`));
    await call(host, { action: 'list' });
    assert.equal(fake.calls[0].headers.Authorization, `Basic ${Buffer.from(`${USERNAME}:${SECRET}`).toString('base64')}`);
    await host.harness.behavior.setSettings({ carddavAppPassword: 'replacement-private-password' });
    await call(host, { action: 'list' });
    assert.equal(fake.calls.at(-1).headers.Authorization, `Basic ${Buffer.from(`${USERNAME}:replacement-private-password`).toString('base64')}`);
    await host.harness.behavior.callRpc('disconnect', null);
    assert.equal((await resolve(host)).tools.length, 1);
    await host.harness.behavior.setSettings({ carddavAppPassword: null });
    assert.deepEqual((await resolve(host)).tools, []);
    const before = fake.calls.length;
    const missing = await call(host);
    assert.equal(missing.isError, true);
    assert.equal(fake.calls.length, before);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /carddav_tool configuration/);
    assert.doesNotMatch(JSON.stringify(missing) + JSON.stringify(host.harness.inspection.logEntries), new RegExp(`${SECRET}|${USERNAME}|${PRIVATE}`));
    for (const invalid of [{ carddavUsername: 'user\n' }, { carddavUsername: 'user:bad' }, { carddavAppPassword: 'bad\r\nsecret' }]) {
      await assert.rejects(host.harness.behavior.setSettings(invalid));
    }
  } finally { await host.harness.lifecycle.dispose(); }
});

test('built BB tool lists, inspects, previews, adds, no-ops and removes with verification', async () => {
  await withHost({}, async (host, fake) => {
    assert.equal(data(await call(host, { action: 'list' })).groups[0].name, 'Feed');
    const inspected = data(await call(host, { ...args, action: 'get' }));
    assert.deepEqual(inspected.currentGroups, []);
    assert.equal(inspected.contact.emails.length, 2);
    assert.equal(inspected.membershipScope, 'whole-contact');
    const preview = data(await call(host));
    assert.equal(preview.applied, false);
    assert.equal(preview.wouldChange, true);
    assert.match(preview.warning, /all 2 email addresses/);
    assert.equal(fake.writes(), 0);
    const applied = data(await call(host, { ...args, apply: true }));
    assert.equal(applied.applied, true);
    assert.equal(applied.verified, true);
    assert.equal(fake.writes(), 1);
    assert.equal(fake.saved().replace('X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:contact-1\r\n', ''), group);
    assert.equal(data(await call(host, { ...args, apply: true })).changed, false);
    assert.equal(fake.writes(), 1);
    const removed = data(await call(host, { ...args, action: 'remove', apply: true }));
    assert.equal(removed.verified, true);
    assert.equal(removed.isMember, false);
    assert.equal(fake.saved(), group);
    assert.equal(fake.writes(), 2);
    assert.deepEqual(host.harness.inspection.logEntries, []);
  });
});

test('BB validation rejects invalid mutations and secrets in arguments before network access', async () => {
  await withHost({}, async (host, fake) => {
    for (const input of [{ ...args, apply: 'true' }, { ...args, password: SECRET }, { action: 'add', group: 'Feed' }, { action: 'get', group: 'Feed', apply: true }, { ...args, group: 'Feed\nInjected' }]) {
      await assert.rejects(call(host, input));
    }
    assert.equal(fake.calls.length, 0);
  });
});

test('BB errors name safe failure categories and never replay uncertain writes', async () => {
  for (const [options, category, message, writes] of [
    [{ denied: true }, 'access_denied', /access denied/, 0],
    [{ conflict: true }, 'conflict', /conflict/, 1],
    [{ uncertain: true }, 'uncertain_write', /outcome is uncertain/, 1],
    [{ verificationFails: true }, 'verification_failed', /was written, but verification failed/, 1],
  ]) {
    await withHost(options, async (host, fake) => {
      const result = await call(host, { ...args, apply: true });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, message);
      assert.equal(fake.writes(), writes);
      assert.match(JSON.stringify(host.harness.inspection.logEntries), new RegExp(`carddav_tool ${category}`));
      assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(host.harness.inspection.logEntries), new RegExp(`${SECRET}|${USERNAME}|${PRIVATE}|sender|Feed|Basic`));
      if (options.uncertain) {
        const inspection = data(await call(host, { ...args, action: 'get' }));
        assert.equal(inspection.isMember, true); // Inspect the committed state; do not resend PUT.
        assert.equal(fake.writes(), 1);
      }
    });
  }
});

test('unexpected transport errors do not echo provider content', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings });
  try {
    await plugin(host.bb, undefined, undefined, async () => { throw new Error(PRIVATE + SECRET); });
    const result = await call(host, { action: 'list' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /carddav_tool transport/);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(host.harness.inspection.logEntries), new RegExp(`${SECRET}|${PRIVATE}`));
  } finally { await host.harness.lifecycle.dispose(); }
});

test('caller cancellation is propagated to fetch but private abort reasons never reach output or logs', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings });
  const controller = new AbortController();
  controller.abort(new Error(PRIVATE + SECRET));
  let writes = 0;
  try {
    await plugin(host.bb, undefined, undefined, async (_url, init) => {
      if (init.method === 'PUT') writes++;
      assert.equal(init.signal.aborted, true);
      throw init.signal.reason;
    });
    const result = await host.harness.behavior.callAgentTool('fastmail_contact_groups', { action: 'list' }, { signal: controller.signal });
    assert.equal(result.isError, true);
    assert.equal(writes, 0);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /carddav_tool unknown/);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(host.harness.inspection.logEntries), new RegExp(`${SECRET}|${PRIVATE}`));
  } finally { await host.harness.lifecycle.dispose(); }
});

test('oversized successful tool output remains bounded and preserves mutation outcome flags', async () => {
  await withHost({ person: card(['UID:contact-1', 'FN:' + 'x'.repeat(40_000), `EMAIL:${args.email}`]) }, async (host, fake) => {
    const result = await call(host, { ...args, apply: true });
    assert(Buffer.byteLength(result.content[0].text) < 32_000);
    const bounded = data(result);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.applied, true);
    assert.equal(bounded.verified, true);
    assert.equal(fake.writes(), 1);
  });
});
