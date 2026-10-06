import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({ connected: z.boolean(), pending: z.boolean(), tools: z.number(), defaultSendingAddress: z.string().nullable() }) },
  begin: { input: z.null(), output: z.object({ url: z.string().url() }) },
  finish: { input: z.object({ callbackUrl: z.string().max(8192) }).strict(), output: z.object({ connected: z.boolean() }) },
  disconnect: { input: z.null(), output: z.object({ disconnected: z.boolean() }) },
  refresh: { input: z.null(), output: z.object({ tools: z.number() }) },
});
