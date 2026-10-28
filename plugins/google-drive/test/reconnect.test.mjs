import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveService, SCOPES } from '../core/service.mjs';
import { createMemoryStore } from '../core/memory-store.mjs';
async function fixture() {
  const store = createMemoryStore();
  await store.addAccount({ subject: 'original', email: 'test@example.org', refreshToken: 'old' });
  const oauth = {
    authorizeUrl: args => { assert.equal(args.loginHint, 'test@example.org'); return `https://example.org/?state=${args.state}`; },
    exchange: async () => ({ scope: SCOPES.join(' '), refresh_token: 'new', access_token: 'access' }),
    identity: async () => ({ sub: 'original', email: 'test@example.org', email_verified: true }),
  };
  const service = createDriveService({ store, oauth });
  const props = { clientId: 'client', redirectUri: 'https://example.org/callback' };
  const { url } = await service.beginConnect({ ...props, subject: 'original' });
  const finish = () => service.finishConnect({ ...props, state: new URL(url).searchParams.get('state'), code: 'code' });
  return { store, oauth, service, finish, props, url };
}
test('reconnect replaces the same account only after verified consent; callback is one-use', async () => {
  const f = await fixture();
  assert.equal((await f.store.bySubject('original')).refreshToken, 'old');
  await f.finish();
  assert.equal((await f.store.bySubject('original')).refreshToken, 'new');
  assert.equal((await f.store.accounts()).length, 1);
  await assert.rejects(f.finish(), /expired or is invalid/);
});
for (const mode of ['wrong-account', 'scope', 'exchange', 'cancel', 'changed', 'removed']) {
  test(`reconnect ${mode} preserves saved account and never creates another`, async () => {
    const f = await fixture();
    if (mode === 'wrong-account') f.oauth.identity = async () => ({ sub: 'other', email: 'other@example.org', email_verified: true });
    if (mode === 'scope') f.oauth.exchange = async () => ({ scope: 'openid email', refresh_token: 'new' });
    if (mode === 'exchange') f.oauth.exchange = async () => { throw Error('private sentinel'); };
    if (mode === 'changed') await f.store.mergeToken('original', 'old', { refreshToken: 'changed' });
    if (mode === 'removed') await f.store.removeAccount('original');
    const finish = mode === 'cancel' ? () => f.service.finishConnect({ ...f.props, state: new URL(f.url).searchParams.get('state'), error: 'access_denied' }) : f.finish;
    await assert.rejects(finish());
    assert.equal((await f.store.bySubject('original'))?.refreshToken, mode === 'removed' ? undefined : mode === 'changed' ? 'changed' : 'old');
    assert.equal(await f.store.bySubject('other'), null);
  });
}
