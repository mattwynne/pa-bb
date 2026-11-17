import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({
    configured: z.boolean(), redirectUri: z.string().nullable(), ready: z.boolean(), error: z.string().nullable(),
    accounts: z.array(z.object({ subject: z.string(), email: z.string() })),
  }) },
  beginConnect: { input: z.null(), output: z.object({ url: z.string().url() }) },
  beginReconnect: { input: z.object({ subject: z.string().min(1) }), output: z.object({ url: z.string().url() }) },
  removeAccount: { input: z.object({ subject: z.string().min(1) }), output: z.object({ removed: z.boolean() }) },
  importOAuthClient: { input: z.object({ source: z.enum(['google-drive', 'google-calendar']) }), output: z.object({ imported: z.boolean() }) },
  refresh: { input: z.null(), output: z.object({ ready: z.boolean() }) },
});
