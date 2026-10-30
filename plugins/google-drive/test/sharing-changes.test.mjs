import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, account, owner, other, named, link } from './sharing-fixtures.mjs';
import { z } from 'zod';
import { createSharingService, sharingChangeParameters, sharingChangeSchema } from '../core/sharing.mjs';
const apply = async (h, input) => h.service.change({ ...input, preview: false });
const status = (h, input) => h.service.status({ account, operationId: input.operationId });
test('native tool schema has a provider-compatible object root and service enforces exact action fields', () => {
  const json = z.toJSONSchema(sharingChangeParameters);
  assert.equal(json.type, 'object'); assert.equal(json.anyOf, undefined); assert.equal(json.oneOf, undefined);
  for (const input of [request({ action: 'revoke', permissionId: 'named-id' }), request({ action: 'change', permissionId: 'named-id', notify: true }), request({ permissionId: 'named-id' })]) {
    assert.equal(sharingChangeParameters.safeParse(input).success, true);
    assert.equal(sharingChangeSchema.safeParse(input).success, false);
  }
});
for (const folder of [false, true]) {
  for (const action of ['grant', 'change', 'revoke']) for (const type of ['user', 'group', 'anyone']) {
    test(`${folder ? 'folder' : 'file'} ${action} ${type} preserves unrelated access and verifies exact difference`, async () => {
      const target = type === 'anyone' ? link : { ...named, type };
      const h = await fixture({ folder, permissions: [owner, other, ...(action === 'grant' ? [] : [target])] });
      const input = action === 'grant' ? request({ audience: type === 'anyone' ? { type } : { type, emailAddress: named.emailAddress } })
        : request({ action, permissionId: target.id });
      if (action !== 'grant') delete input.audience;
      if (action === 'revoke') delete input.role;
      try {
        const preview = await h.service.change(input);
        assert.equal(preview.outcome, 'proposed'); assert.equal(preview.receiptOnly, false); assert.equal(preview.freshlyInspected, true); assert.equal(h.writes().length, 0);
        assert.equal((await h.service.change(input)).receiptOnly, true);
        assert.equal(preview.preview.kind, folder ? 'folder' : 'file');
        assert.match(preview.preview.impact, folder ? /future items.*not enumerated.*No descendant/ : /only this item/);
        assert.match(preview.preview.notification, /No .*invitation/);
        const done = await apply(h, input); assert.equal(done.outcome, 'verified', JSON.stringify(done));
        assert.equal(h.writes().length, 1); assert.ok(h.state.permissions.some(p => p.id === other.id && p.role === 'reader'));
        assert.ok(h.state.permissions.some(p => p.id === owner.id && p.role === 'owner'));
        assert.equal((await status(h, input)).outcome, 'verified');
        assert.equal((await apply(h, input)).outcome, 'verified'); assert.equal(h.writes().length, 1);
        if (type === 'anyone' && action !== 'revoke') assert.equal(h.state.permissions.find(p => p.type === 'anyone').allowFileDiscovery, false);
      } finally { await h.close(); }
    });
  }
}
test('named commenter allowed; searchable public access is reduced to link-only, never created', async () => {
  for (const opts of [{ type: 'user', role: 'commenter' }, { type: 'anyone', role: 'writer' }]) {
    const h = await fixture({ permissions: [owner, other, ...(opts.type === 'anyone' ? [{ ...link, allowFileDiscovery: true }] : [])] });
    try {
      const input = opts.type === 'anyone' ? request({ action: 'change', permissionId: link.id, role: opts.role }) : request({ role: opts.role });
      if (input.action === 'change') delete input.audience;
      const p = await h.service.change(input);
      if (opts.type === 'anyone') { assert.match(p.preview.from, /publicly discoverable/); assert.match(p.preview.to, /not searchable/); }
      assert.equal((await apply(h, input)).outcome, 'verified');
    } finally { await h.close(); }
  }
});
test('notifications default off, opt in only on named grants, and not on public grants', async () => {
  for (const notify of [false, true]) {
    const h = await fixture();
    try {
      const input = request({ notify }); const p = await h.service.change(input);
      assert.match(p.preview.notification, notify ? /opted in/ : /notifications off/);
      assert.equal((await apply(h, input)).outcome, 'verified');
      assert.equal(h.writes()[0].url.searchParams.get('sendNotificationEmail'), String(notify));
    } finally { await h.close(); }
  }
  for (const input of [request({ audience: { type: 'anyone' }, notify: true }), request({ audience: { type: 'anyone' }, role: 'commenter' }), request({ audience: { type: 'anyone', allowFileDiscovery: true } })]) {
    const h = await fixture();
    try { await assert.rejects(h.service.change(input)); assert.equal(h.writes().length, 0); } finally { await h.close(); }
  }
});
for (const options of [{ scope: 'drive.readonly' }, { scope: 'documents' }, { wrongIdentity: true }, { sharedDrive: true }, { notOwned: true }, { noAuthority: true }, { limited: true }, { incomplete: true }, { permissionsFailure: true },
  { ancestors: [owner, named], permissions: [owner, other, named] }, { permissions: [owner, other, { ...named, permissionDetails: [{ inherited: true }] }] }]) {
  test(`fails closed for ${JSON.stringify(options)}`, async () => {
    const h = await fixture(options);
    try {
      const input = options.permissions ? request({ action: 'change', permissionId: named.id }) : request();
      if (input.action === 'change') delete input.audience;
      await assert.rejects(h.service.change(input)); assert.equal(h.writes().length, 0);
      assert.equal(await h.store.getSharing(input.operationId), null);
    } finally { await h.close(); }
  });
}
test('unknown inheritance on orphan and uninspectable ancestors is blocked, owners/domain/expiration cannot be changed', async () => {
  for (const options of [{ permissions: [owner, other, { ...named, expirationTime: '2027-01-01T00:00:00Z' }] },
    { permissions: [owner, other, { ...named, type: 'domain', domain: 'example.test', allowFileDiscovery: false }] },
    { permissions: [owner, other] }]) {
    const h = await fixture(options);
    try {
      const input = request({ action: 'revoke', permissionId: options.permissions.some(p => p.id === named.id) ? named.id : owner.id });
      delete input.audience; delete input.role;
      await assert.rejects(h.service.change(input)); assert.equal(h.writes().length, 0);
    } finally { await h.close(); }
  }
  const h = await fixture(); try { h.state.metadata = { parents: undefined }; await assert.rejects(h.service.change(request())); } finally { await h.close(); }
});
test('all denied/cancelled/malformed/expired approvals consume key without writing', async () => {
  for (const decision of [{ outcome: 'submitted', value: { approved: false } }, { outcome: 'submitted', value: { approved: true, extra: 1 } },
    ...['user', 'timeout', 'request-aborted', 'thread-stopped', 'thread-deleted', 'plugin-disposed', 'server-restarted'].map(reason => ({ outcome: 'cancelled', reason }))]) {
    const h = await fixture({ approve: async () => decision }); const input = request();
    try { assert.notEqual((await apply(h, input)).outcome, 'verified'); assert.equal(h.writes().length, 0); assert.equal((await apply(h, input)).receiptOnly, true); }
    finally { await h.close(); }
  }
  const h = await fixture(); const input = request();
  try { await h.service.change(input); h.state.now += 600_000; assert.equal((await apply(h, input)).outcome, 'expired'); assert.equal(h.writes().length, 0); } finally { await h.close(); }
});
test('stale preview, authority, permission and approval-time expiry prevent submission', async () => {
  for (const modify of [h => h.state.permissions.push({ ...named, id: 'changed' }), h => { h.state.metadata = { capabilities: { canShare: false } }; }, h => { h.state.now += 600_000; }]) {
    let h;
    h = await fixture({ approve: async () => { modify(h); return { outcome: 'submitted', value: { approved: true } }; } });
    try { assert.notEqual((await apply(h, request())).outcome, 'verified'); assert.equal(h.writes().length, 0); } finally { await h.close(); }
  }
});
test('same key/request joins receipt, different request conflicts, and competing item proposals serialize', async () => {
  let release; const h = await fixture({ approve: () => new Promise(resolve => { release = resolve; }) }); const input = request();
  try {
    const first = apply(h, input);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await apply(h, input)).outcome, 'reviewing'); assert.equal((await status(h, input)).inProgress, true);
    await assert.rejects(apply(h, request()), e => e.sharingCode === 'busy');
    await assert.rejects(h.service.change({ ...input, role: 'reader' }), /different request/);
    release({ outcome: 'submitted', value: { approved: true } });
    assert.equal((await first).outcome, 'verified'); assert.equal(h.writes().length, 1);
  } finally { await h.close(); }
});
for (const options of [{ lostReply: true }, { badJson: true }, { reject: 503 }, { noApply: true }, { afterWrite: state => { state.failReads = true; } }, { afterWrite: state => { state.permissions.find(p => p.id === other.id).role = 'writer'; } }, { returnedId: 'wrong-id' }]) {
  test(`uncertain write has no retry/rollback; read-only recovery ${JSON.stringify(options)}`, async () => {
    const h = await fixture(options); const input = request();
    try {
      assert.equal((await apply(h, input)).outcome, 'uncertain'); assert.equal(h.writes().length, 1);
      assert.equal((await apply(h, input)).receiptOnly, true); assert.equal(h.writes().length, 1);
      h.state.failReads = false;
      const recovered = await status(h, input);
      const expected = options.lostReply || options.badJson ? 'observed_matching'
        : options.afterWrite && h.state.permissions.find(p => p.id === other.id).role === 'reader' ? 'verified' : 'uncertain';
      assert.equal(recovered.outcome, expected);
      assert.equal(h.writes().length, 1);
      if (recovered.outcome !== 'verified') {
        await assert.rejects(apply(h, request({ audience: { type: 'user', emailAddress: 'another@example.test' } })), e => e.sharingCode === 'busy');
      }
    } finally { await h.close(); }
  });
}
test('restart recovers interrupted review without authorizing its old callback; writing recovery only reads', async () => {
  let release; const h = await fixture({ approve: () => new Promise(resolve => { release = resolve; }) }); const input = request();
  try {
    const pending = apply(h, input); while (!release) await new Promise(resolve => setImmediate(resolve));
    const restarted = createSharingService(h.ports);
    assert.equal((await restarted.status({ account, operationId: input.operationId })).outcome, 'cancelled');
    release({ outcome: 'submitted', value: { approved: true } });
    assert.equal((await pending).outcome, 'not_submitted'); assert.equal(h.writes().length, 0);
    const op = await h.store.getSharing(input.operationId); op.state = 'writing'; await h.store.updateSharing(op);
    assert.equal((await restarted.status({ account, operationId: input.operationId })).outcome, 'uncertain'); assert.equal(h.writes().length, 0);
  } finally { await h.close(); }
});
test('native tool enforces approval even with Docs approval disabled and logs safe failure diagnostics', async () => {
  const h = await fixture({ lostReply: true }); const input = request();
  try {
    const done = h.harness.behavior.callAgentTool('gdrive_change_sharing', { ...input, preview: false }, { threadId: 'synthetic-thread' });
    while (!h.harness.inspection.pendingInteractions.length) await new Promise(resolve => setImmediate(resolve));
    const p = h.harness.inspection.pendingInteractions[0];
    assert.equal(p.threadId, 'synthetic-thread'); assert.equal(p.rendererId, 'drive-sharing-approval');
    assert.match(p.payload.to, /writer/);
    h.harness.behavior.submitInteraction(p.id, { approved: true });
    assert.equal(JSON.parse((await done).content[0].text).outcome, 'uncertain');
    const logs = JSON.stringify(h.harness.inspection.logEntries);
    assert.match(logs, /sharing_write/); assert.doesNotMatch(logs, /PRIVATE|example.test|recipient|Synthetic target|owner-id|new-id|subject/);
    assert.equal(h.writes().length, 1);
  } finally { await h.close(); }
});
