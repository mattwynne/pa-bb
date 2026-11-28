import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const appleState = z.enum(['disconnected', 'shared', 'unavailable']);
const id = z.string().uuid();
const entry = z.object({ name: z.string(), directory: z.boolean(), size: z.number().int().nonnegative().nullable() });
const error = z.object({ ok: z.literal(false), error: z.string() });

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({ apple: appleState, grain: z.string().nullable() }) },
  browse: {
    input: z.object({ parent: z.object({ listing: id, index: z.number().int().nonnegative().nullable() }).strict().nullable() }).strict(),
    output: z.union([error, z.object({ ok: z.literal(true), listing: id, total: z.number(), entries: z.array(entry) })]),
  },
  page: {
    input: z.object({ listing: id, offset: z.number().int().nonnegative() }).strict(),
    output: z.union([error, z.object({ ok: z.literal(true), entries: z.array(entry) })]),
  },
  download: {
    input: z.object({ listing: id, index: z.number().int().nonnegative(), mode: z.enum(['download', 'preview']) }).strict(),
    output: z.union([error, z.object({ ok: z.literal(true), ticket: id })]),
  },
  checkGrain: { input: z.null(), output: z.union([error, z.object({ ok: z.literal(true) })]) },
});
