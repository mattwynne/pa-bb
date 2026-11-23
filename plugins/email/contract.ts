import { z } from 'zod';

export const providerId = z.enum(['google-workspace', 'fastmail']);
export type ProviderId = z.infer<typeof providerId>;
export const accountKey = z.string().regex(/^[a-f0-9]{64}$/);
const remoteId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const accounts = z.array(z.object({ id: remoteId, email: z.string().min(1).max(320) })).max(100);
export const page = z.object({
  ids: z.array(remoteId).max(25),
  next: z.string().max(4096).nullable(),
  restart: z.boolean().optional(),
});
export const maxMimeBytes = 32 * 1024 * 1024;
export const message = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    mime: z.string().min(1).max(Math.ceil(maxMimeBytes * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
  z.object({ status: z.enum(['missing', 'too_large']) }),
]);
export const accountView = z.object({
  key: accountKey,
  provider: providerId,
  email: z.string(),
  connected: z.boolean(),
  selected: z.boolean(),
  phase: z.enum(['off', 'queued', 'indexing', 'searchable', 'paused', 'error']),
  indexed: z.number(),
  omitted: z.number(),
  completedAt: z.string().nullable(),
  error: z.enum(['provider', 'msgvault', 'storage']).nullable(),
});
export const rpcContract = {
  status: { input: z.object({ refresh: z.literal(true) }).nullable(), output: z.object({
    runtime: z.enum(['ready', 'missing', 'unsupported', 'unavailable']),
    providers: z.array(z.object({ id: providerId, status: z.enum(['ready', 'empty', 'unavailable']) })),
    accounts: z.array(accountView),
  }) },
  selectAccount: {
    input: z.object({ key: accountKey, selected: z.boolean() }),
    output: z.null(),
  },
  refreshAccount: { input: z.object({ key: accountKey }), output: z.null() },
};
