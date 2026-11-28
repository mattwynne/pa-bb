import { z } from 'zod';

const state = z.enum(['disconnected', 'shared', 'unavailable']);
const id = z.string().uuid();
const location = z.object({ listing: id, index: z.number().int().nonnegative().nullable() }).strict();
const entry = z.object({ name: z.string(), directory: z.boolean(), size: z.number().int().nonnegative().nullable() });
const error = z.object({ ok: z.literal(false), error: z.string() });

export const photosContract = {
  photosStatus: { input: z.null(), output: state },
  photosBrowse: {
    input: z.object({ parent: location.nullable() }).strict(),
    output: z.union([error, z.object({ ok: z.literal(true), listing: id, total: z.number(), entries: z.array(entry) })]),
  },
  photosPage: {
    input: z.object({ listing: id, offset: z.number().int().nonnegative() }).strict(),
    output: z.union([error, z.object({ ok: z.literal(true), entries: z.array(entry) })]),
  },
  photosTicket: {
    input: z.object({ listing: id, index: z.number().int().nonnegative(), mode: z.enum(['download', 'preview']) }).strict(),
    output: z.union([error, z.object({ ok: z.literal(true), ticket: id })]),
  },
};
