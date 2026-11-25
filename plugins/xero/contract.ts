import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({
    configured: z.boolean(), connected: z.boolean(), redirectUri: z.string().nullable(), error: z.string().nullable(),
    organisations: z.array(z.object({ tenantId: z.uuid(), tenantName: z.string(), checkedAt: z.string().nullable() })),
    scopes: z.array(z.string()),
  }) },
  beginConnect: { input: z.null(), output: z.object({ url: z.string().url() }) },
  disconnect: { input: z.null(), output: z.object({ disconnected: z.literal(true) }) },
  refresh: { input: z.null(), output: z.object({ refreshed: z.literal(true) }) },
  check: { input: z.object({ tenantId: z.uuid() }), output: z.object({ checkedAt: z.string() }) },
});
export type Status = z.infer<typeof rpcContract.status.output>;
