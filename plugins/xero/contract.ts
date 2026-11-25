import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { captureId, captureSummary, MAX_CAPTURE_BYTES } from './bank-rec.ts';
const bankFailure = z.object({ ok: z.literal(false), error: z.string() });
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({
    configured: z.boolean(), connected: z.boolean(), redirectUri: z.string().nullable(), error: z.string().nullable(),
    organisations: z.array(z.object({ tenantId: z.uuid(), tenantName: z.string(), tenantType: z.string(), checkedAt: z.string().nullable() })),
    scopes: z.array(z.string()), requestedScopes: z.array(z.string()), missingScopes: z.array(z.string()), appStoreEnabled: z.boolean(),
  }) },
  bankRecInstaller: { input: z.object({ tenantId: z.uuid() }), output: z.union([bankFailure, z.object({ ok: z.literal(true), html: z.string(), filename: z.string(), accountCount: z.number().int() })]) },
  bankRecImport: { input: z.object({ tenantId: z.uuid(), json: z.string().max(MAX_CAPTURE_BYTES) }), output: z.union([bankFailure, z.object({ ok: z.literal(true), outcome: z.enum(['imported', 'already_imported']), capture: captureSummary })]) },
  bankRecList: { input: z.object({ tenantId: z.uuid(), page: z.number().int().min(1).default(1) }), output: z.union([bankFailure, z.object({ ok: z.literal(true), captures: z.array(captureSummary), total: z.number().int(), nextPage: z.number().int().nullable(), notice: z.string() })]) },
  bankRecRemove: { input: z.object({ tenantId: z.uuid(), captureId }), output: z.union([bankFailure, z.object({ ok: z.literal(true), removed: z.boolean() })]) },
  beginConnect: { input: z.null(), output: z.object({ url: z.string().url() }) },
  disconnect: { input: z.null(), output: z.object({ disconnected: z.literal(true) }) },
  refresh: { input: z.null(), output: z.object({ refreshed: z.literal(true) }) },
  check: { input: z.object({ tenantId: z.uuid() }), output: z.object({ checkedAt: z.string() }) },
});
export type Status = z.infer<typeof rpcContract.status.output>;
