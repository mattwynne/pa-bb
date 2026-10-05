import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ configured: z.boolean(), redirectUri: z.string().nullable(), accounts: z.array(z.object({ subject: z.string(), email: z.string(), status: z.string() })) }),
  },
  beginConnect: {
    input: z.null(),
    output: z.object({ url: z.string().url() }),
  },
  removeAccount: {
    input: z.object({ subject: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
});
