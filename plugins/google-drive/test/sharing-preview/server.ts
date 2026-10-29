import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createSharingAdapter } from '../../adapters/sharing.mjs';
const states = ['user', 'link', 'folder', 'change', 'remove', 'discoverable', 'invalid', 'error', 'busy'] as const;
// Fixture only: inert native interactions, no agent tools, real accounts,
// credentials or provider transport. Production adapter constructs the copy.
export default function plugin(bb: BbPluginApi) {
  const results = new Map<string, unknown>();
  bb.rpc.register({
    stage: { input: z.object({ threadId: z.string(), state: z.enum(states) }), output: z.object({ staged: z.boolean() }) },
    result: { input: z.object({ threadId: z.string() }), output: z.any() },
  }, {
    async stage({ threadId, state }) {
      const owner = { id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.test' };
      const publicPermission = { id: 'public', type: 'anyone', role: 'reader', allowFileDiscovery: state === 'discoverable' };
      const current = ['change', 'remove', 'discoverable'].includes(state);
      const adapter = createSharingAdapter({ verifiedAccess: async () => 'synthetic-no-credential',
        fetchImpl: async () => Response.json({ scope: 'https://www.googleapis.com/auth/drive' }),
        drive: {
          getSharingMetadata: async (_r: unknown, id: string) => ({ id: id === 'root' ? 'root-id' : id, name: 'Synthetic feedback document with a long but readable title',
            mimeType: state === 'folder' || id !== 'synthetic-item' ? 'application/vnd.google-apps.folder' : 'application/vnd.google-apps.document', trashed: false,
            parents: id === 'synthetic-item' ? ['root-id'] : undefined, owners: [{ me: true }], capabilities: { canShare: true } }),
          listPermissions: async (_r: unknown, id: string) => ({ permissions: id === 'synthetic-item' && current ? [owner, publicPermission] : [owner] }),
        } });
      const request = { fileId: 'synthetic-item', action: state === 'remove' ? 'revoke' : current ? 'change' : 'grant',
        ...(current ? { permissionId: 'public' } : { audience: ['link', 'folder'].includes(state) ? { type: 'anyone' } : { type: 'user', emailAddress: 'recipient@example.test' }, notify: state === 'user' }),
        ...(state !== 'remove' ? { role: 'writer' } : {}) };
      const { preview } = await adapter.propose({ subject: 'synthetic-owner', email: 'owner@example.test' }, request);
      results.delete(threadId);
      void bb.ui.requestInput({ threadId, rendererId: 'drive-sharing-approval', title: 'Review sharing change (synthetic)',
        payload: state === 'invalid' ? { reviewState: state } : { ...preview, operationId: '00000000-0000-4000-8000-000000000001', reviewState: state },
        describeSubmission: () => ({ title: 'Synthetic choice recorded — no Google write' }),
      }).then(value => results.set(threadId, value), () => results.set(threadId, { outcome: 'interrupted' }));
      return { staged: true };
    },
    async result({ threadId }) { return results.get(threadId) ?? null; },
  });
}
