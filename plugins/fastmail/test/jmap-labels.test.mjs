import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateEmailLabels } from '../jmap-labels.ts';

const TOKEN = 'synthetic-private-jmap-token';
const MAIL = 'urn:ietf:params:jmap:mail';
const mailbox = (id, name, role = null, parentId = null) => ({ id, name, role, parentId, myRights: { mayAddItems: true, mayRemoveItems: true } });
const mailboxes = () => [mailbox('in', 'Inbox', 'inbox'), mailbox('screen', 'Screener'), mailbox('work', 'Work'), mailbox('trash', 'Trash', 'trash')];
const email = (id = 'M1', memberships = ['screen', 'work']) => ({ id, blobId: 'B1', threadId: 'T1', mailboxIds: Object.fromEntries(memberships.map(id => [id, true])), keywords: { '$flagged': true } });
function fixture(options = {}) {
  let boxes = options.mailboxes ?? mailboxes();
  let emails = options.emails ?? [email()];
  let writes = 0; let reads = 0;
  const calls = []; const logs = [];
  const fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, 'error');
    if (init.signal.aborted) throw new Error('private abort');
    if (url.endsWith('/session')) return Response.json(options.session ?? { apiUrl: 'https://api.fastmail.com/jmap/api/', primaryAccounts: { [MAIL]: 'A1' }, accounts: { A1: { accountCapabilities: { [MAIL]: {} } } } });
    const request = JSON.parse(init.body); calls.push(request);
    const [method, args, id] = request.methodCalls[0];
    assert.equal(args.accountId, 'A1');
    let data;
    if (method === 'Mailbox/get') data = { accountId: 'A1', list: boxes, notFound: [] };
    else if (method === 'Email/get') {
      reads++;
      assert.deepEqual(args.properties, ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords']);
      if (options.verifyFails && writes) throw new Error('private verification content');
      data = options.snapshot ?? { accountId: 'A1', state: `s${reads}`, list: structuredClone(emails), notFound: [] };
    } else {
      writes++;
      assert.equal(method, 'Email/set');
      assert.equal(typeof args.ifInState, 'string');
      if (options.stateMismatch && (writes === 1 || options.stateMismatch === 'always')) return Response.json({ methodResponses: [['error', { type: 'stateMismatch' }, id]] });
      if (options.reject) return Response.json({ methodResponses: [['error', { type: 'forbidden', description: 'private content' }, id]] });
      if (!options.unapplied) {
        for (const e of emails) for (const [key, value] of Object.entries(options.partial && e.id === 'M1' ? {} : args.update[e.id] ?? {})) {
          const [field, mid] = key.split('/');
          if (value === null) delete e[field][mid]; else e[field][mid] = value;
        }
      }
      if (options.diverge) emails[0].keywords['$seen'] = true;
      if (options.uncertain) throw new Error('private transport content');
      data = { accountId: 'A1', updated: Object.fromEntries(Object.keys(args.update).map(id => [id, null])) };
      if (options.partial) data = { accountId: 'A1', updated: Object.fromEntries(Object.keys(args.update).filter(id => id !== 'M1').map(id => [id, null])), notUpdated: { M1: { type: 'forbidden', description: 'private provider content' } } };
      if (options.missingResult) data = { accountId: 'A1' };
      if (options.malformedSet) data = { accountId: 'A1', updated: [] };
    }
    return Response.json({ methodResponses: [[method, data, id]] });
  };
  return { run: args => updateEmailLabels(TOKEN, args, { fetch, diagnose: (stage, category) => logs.push(`${stage} ${category}`) }), calls, logs, writes: () => writes, reads: () => reads };
}
const request = { emailIds: ['M1'], addLabels: ['Inbox'], removeLabels: ['Screener'] };
test('preview resolves Inbox by role and does not write or request bodies', async () => {
  const f = fixture({ mailboxes: [mailbox('in', 'Boîte de réception', 'inbox'), ...mailboxes().slice(1)] });
  const result = await f.run(request);
  assert.equal(result.status, 'preview'); assert.equal(f.writes(), 0);
  assert.deepEqual(result.proposals[0].before, ['Screener', 'Work']);
  assert.deepEqual(result.proposals[0].after, ['Boîte de réception', 'Work']);
});
test('apply uses per-membership patches, preserves other labels and keywords, and verifies', async () => {
  const f = fixture(); const result = await f.run({ ...request, apply: true });
  assert.equal(result.status, 'applied'); assert.equal(f.writes(), 1); assert.equal(f.reads(), 2);
  assert.deepEqual(f.calls.find(r => r.methodCalls[0][0] === 'Email/set').methodCalls[0][1].update, { M1: { 'mailboxIds/in': true, 'mailboxIds/screen': null } });
  assert.equal(result.results.M1.verification.status, 'verified');
});
test('already matching memberships is a no-op', async () => {
  const f = fixture({ emails: [email('M1', ['in', 'work'])] });
  assert.equal((await f.run({ ...request, apply: true })).status, 'noop'); assert.equal(f.writes(), 0);
});
for (const [name, options, args] of [
  ['ambiguous leaf', { mailboxes: [...mailboxes(), mailbox('nested', 'Screener', null, 'work')] }, request],
  ['overlapping aliases', {}, { emailIds: ['M1'], addLabels: ['Inbox'], removeLabels: ['inbox'] }],
  ['system labels', {}, { emailIds: ['M1'], addLabels: ['Trash'] }],
  ['empty membership', { emails: [email('M1', ['screen'])] }, { emailIds: ['M1'], removeLabels: ['Screener'] }],
  ['missing rights', { mailboxes: mailboxes().map(m => m.id === 'in' ? { ...m, myRights: {} } : m) }, request],
  ['unknown mailbox membership', { emails: [email('M1', ['unknown'])] }, request],
  ['incomplete hierarchy', { mailboxes: [...mailboxes(), mailbox('child', 'Child', null, 'missing')] }, request],
  ['cyclic hierarchy', { mailboxes: [...mailboxes(), mailbox('child', 'Child', null, 'child')] }, request],
  ['duplicate system role', { mailboxes: [...mailboxes(), mailbox('other', 'Other', 'inbox')] }, request],
  ['missing email', { emails: [] }, request],
  ['duplicate emails', { emails: [email(), email()] }, request],
  ['missing Email/get state', { snapshot: { accountId: 'A1', list: [email()], notFound: [] } }, request],
  ['missing Email/get notFound', { snapshot: { accountId: 'A1', state: 's1', list: [email()] } }, request],
  ['too many mailboxes', { mailboxes: [mailbox('in', 'Inbox', 'inbox'), ...Array.from({ length: 2048 }, (_, i) => mailbox(`b${i}`, `Box ${i}`))] }, request],
  ['oversized proposal', { mailboxes: [mailbox('in', 'Inbox', 'inbox'), ...Array.from({ length: 200 }, (_, i) => mailbox(`b${i}`, `${i}${'x'.repeat(500)}`))], emails: [email('M1', Array.from({ length: 200 }, (_, i) => `b${i}`))] }, { emailIds: ['M1'], addLabels: ['Inbox'] }],
  ['patch path injection', {}, { emailIds: ['M1/a'], addLabels: ['Inbox'] }],
  ['unknown arguments', {}, { ...request, isRead: true }],
  ['oversized batch', {}, { ...request, emailIds: Array.from({ length: 51 }, (_, i) => `M${i}`) }],
]) test(`reject ${name} before writing`, async () => {
  const f = fixture(options); await assert.rejects(f.run({ ...args, apply: true })); assert.equal(f.writes(), 0);
});
test('unknown write outcome rereads exactly once, never resends, and logs no secrets', async () => {
  const f = fixture({ uncertain: true }); const result = await f.run({ ...request, apply: true });
  assert.equal(result.status, 'verified_after_uncertain'); assert.equal(f.writes(), 1); assert.equal(f.reads(), 2);
  assert.match(f.logs.join(), /jmap_update transport/);
  assert.doesNotMatch(JSON.stringify(f.logs), /private|M1|Inbox|Screener|synthetic/);
});
test('uncertain unapplied result is not reported as successful', async () => {
  const f = fixture({ uncertain: true, unapplied: true });
  assert.equal((await f.run({ ...request, apply: true })).status, 'uncertain_diverged'); assert.equal(f.writes(), 1);
});
test('malformed Email/set result is uncertain and still reread once', async () => {
  const f = fixture({ malformedSet: true });
  assert.equal((await f.run({ ...request, apply: true })).status, 'verified_after_uncertain'); assert.equal(f.writes(), 1); assert.equal(f.reads(), 2);
});
test('verification failure cannot claim the write failed or succeed', async () => {
  const f = fixture({ verifyFails: true });
  await assert.rejects(f.run({ ...request, apply: true }), /may have completed/); assert.equal(f.writes(), 1);
});
test('partial provider rejection stays partial even after reread', async () => {
  const f = fixture({ partial: true }); const result = await f.run({ ...request, apply: true });
  assert.equal(result.status, 'partial'); assert.equal(result.results.M1.status, 'notUpdated');
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.logs), /private provider content/);
});
test('unexpected keyword change fails exact verification', async () => {
  const f = fixture({ diverge: true }); assert.equal((await f.run({ ...request, apply: true })).status, 'partial');
});
test('only explicit stateMismatch permits a single replan and retry', async () => {
  const f = fixture({ stateMismatch: true });
  assert.equal((await f.run({ ...request, apply: true })).status, 'applied'); assert.equal(f.writes(), 2);
});
test('definitive rejection is not retried', async () => {
  const f = fixture({ reject: true }); await assert.rejects(f.run({ ...request, apply: true })); assert.equal(f.writes(), 1);
});
test('repeated stateMismatch stops after one safe retry', async () => {
  const f = fixture({ stateMismatch: 'always' });
  await assert.rejects(f.run({ ...request, apply: true })); assert.equal(f.writes(), 2);
});
test('mixed batch reports failed and verified emails separately', async () => {
  const f = fixture({ partial: true, emails: [email('M1'), email('M2')] });
  const result = await f.run({ ...request, emailIds: ['M1', 'M2'], apply: true });
  assert.equal(result.status, 'partial');
  assert.equal(result.results.M1.status, 'notUpdated');
  assert.equal(result.results.M2.status, 'updated');
  assert.equal(result.results.M2.verification.status, 'verified');
  assert.equal(f.writes(), 1);
});
test('missing object result remains partial even when visible state matches', async () => {
  const f = fixture({ missingResult: true });
  const result = await f.run({ ...request, apply: true });
  assert.equal(result.status, 'partial'); assert.equal(result.results.M1.status, 'uncertain');
});
test('missing mail capability is a safe setup failure', async () => {
  const f = fixture({ session: { primaryAccounts: { [MAIL]: 'A1' }, accounts: { A1: { accountCapabilities: {} } } } });
  await assert.rejects(f.run(request), /mail account/); assert.equal(f.calls.length, 0);
});
test('HTTP errors, malformed bodies, and oversized responses expose no provider content', async () => {
  for (const response of [new Response('private-provider-body', { status: 403 }), new Response('private-malformed-json'), new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
    await assert.rejects(updateEmailLabels(TOKEN, request, { fetch: async () => response }), error => {
      assert.doesNotMatch(error.message + error.category, /private|synthetic/); return true;
    });
  }
});
test('already-cancelled request never contacts Fastmail', async () => {
  const controller = new AbortController(); controller.abort('private cancellation');
  await assert.rejects(updateEmailLabels(TOKEN, request, { signal: controller.signal, fetch: async () => { throw new Error('must not fetch'); } }), error => error.category === 'cancelled');
});
test('session endpoints must be Fastmail HTTPS JMAP paths', async () => {
  for (const apiUrl of ['https://evil.example/jmap/api/', 'http://api.fastmail.com/jmap/api/', 'https://api.fastmail.com/not-jmap', 'https://user@api.fastmail.com/jmap/api/']) {
    const f = fixture({ session: { apiUrl, primaryAccounts: { [MAIL]: 'A1' }, accounts: { A1: { accountCapabilities: { [MAIL]: {} } } } } });
    await assert.rejects(f.run(request)); assert.equal(f.calls.length, 0);
  }
});
test('no token or invalid token never contacts provider', async () => {
  for (const token of ['', 'bad\r\ntoken']) await assert.rejects(updateEmailLabels(token, request, { fetch: () => { throw new Error('must not fetch'); } }));
});
