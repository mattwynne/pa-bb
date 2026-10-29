import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { createSharingService } from '../core/sharing.mjs';
export const account = 'synthetic-owner@example.test';
export const owner = { id: 'owner-id', type: 'user', role: 'owner', emailAddress: account };
export const other = { id: 'other-id', type: 'user', role: 'reader', emailAddress: 'unrelated@example.test' };
export const named = { id: 'named-id', type: 'user', role: 'reader', emailAddress: 'synthetic-recipient@example.test' };
export const link = { id: 'public-id', type: 'anyone', role: 'reader', allowFileDiscovery: false };
export const request = (extra = {}) => ({ account, operationId: randomUUID(), fileId: 'item', action: 'grant', audience: { type: 'user', emailAddress: named.emailAddress }, role: 'writer', ...extra });
export async function fixture(options = {}) {
  const h = createFakePluginHost({ pluginId: 'google-drive', settings: { requireDocsApproval: false } });
  const calls = [], state = { permissions: structuredClone(options.permissions || [owner, other]), ancestors: structuredClone(options.ancestors || [owner]), now: 1000, failReads: false, scope: options.scope || 'drive' };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname.endsWith('/userinfo')) return Response.json({ sub: options.wrongIdentity ? 'wrong' : 'subject', email: account, email_verified: true });
    if (url.pathname.endsWith('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${state.scope}` });
    if (url.pathname.includes('/permissions') && ['POST', 'PATCH', 'DELETE'].includes(init.method)) {
      const body = init.body && JSON.parse(init.body);
      if (options.reject) return Response.json({ private: 'PRIVATE-CONTENT' }, { status: options.reject });
      const pid = url.pathname.split('/').at(-1);
      const grantedId = options.permissionId || (state.permissions.some(p => p.id === 'new-id') ? `new-id-${state.permissions.length}` : 'new-id');
      if (!options.noApply) {
        if (init.method === 'POST') state.permissions.push({ id: grantedId, ...body });
        if (init.method === 'PATCH') Object.assign(state.permissions.find(p => p.id === pid), body);
        if (init.method === 'DELETE') state.permissions = state.permissions.filter(p => p.id !== pid);
        options.afterWrite?.(state);
      }
      if (options.lostReply) throw Object.assign(new Error('PRIVATE-CONTENT access-token email@example.test'), { code: 'PRIVATE-CODE', cause: 'PRIVATE-CAUSE' });
      if (options.badJson) return new Response('PRIVATE-CONTENT');
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ id: options.returnedId || (init.method === 'POST' ? grantedId : pid) });
    }
    if (state.failReads) throw new Error('PRIVATE-CONTENT');
    if (url.pathname.endsWith('/permissions')) {
      const id = url.pathname.split('/').at(-2);
      if (options.permissionsFailure) return Response.json({ private: 'PRIVATE-CONTENT' }, { status: 403 });
      return Response.json({ permissions: id === 'item' ? state.permissions : state.ancestors,
        ...(options.incomplete ? { nextPageToken: 'repeated' } : {}) });
    }
    const id = url.pathname.split('/').at(-1);
    return Response.json({ id: id === 'root' ? 'root-id' : id, name: 'Synthetic target', mimeType: options.folder || id !== 'item' ? 'application/vnd.google-apps.folder' : 'application/vnd.google-apps.document',
      trashed: false, shared: state.permissions.length > 1, parents: id === 'item' ? ['root-id'] : undefined,
      driveId: options.sharedDrive ? 'shared-drive' : undefined, inheritedPermissionsDisabled: options.limited === true,
      owners: [{ me: !options.notOwned, emailAddress: account }], capabilities: { canShare: !options.noAuthority },
      ...state.metadata });
  };
  const oldFetch = globalThis.fetch; globalThis.fetch = fetchImpl;
  await plugin(h.bb);
  const store = createBbStore(h.bb.storage.database(), () => {});
  await store.addAccount({ subject: 'subject', email: account, accessToken: 'PRIVATE-TOKEN', refreshToken: 'PRIVATE-REFRESH', expiresAt: Date.now() + 1e6 });
  const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl });
  const diagnoses = [];
  const ports = { store, sharing: adapter.sharing, clock: () => state.now, diagnose: (stage) => diagnoses.push(stage),
    approve: options.approve || (async () => ({ outcome: 'submitted', value: { approved: true } })) };
  return { ...h, state, store, calls, diagnoses, ports, service: createSharingService(ports),
    writes: () => calls.filter(c => ['POST', 'PATCH', 'DELETE'].includes(c.init.method) && !c.url.pathname.endsWith('/tokeninfo')),
    close: async () => { globalThis.fetch = oldFetch; await h.harness.lifecycle.dispose(); } };
}
