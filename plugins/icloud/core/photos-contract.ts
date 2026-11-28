import { z } from 'zod';

const state = z.enum(['disconnected', 'shared', 'unavailable']);
const id = z.string().uuid();
const location = z.object({ listing: id, index: z.number().int().nonnegative().nullable() }).strict();
const entry = z.object({ name: z.string(), directory: z.boolean(), size: z.number().int().nonnegative().nullable() });
const error = z.object({ ok: z.literal(false), error: z.string() });
const success = <T extends z.ZodRawShape>(shape: T) => z.union([error, z.object({ ok: z.literal(true), ...shape })]);
const recordId = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/);
const library = { library: recordId };
const page = { ...library, album: recordId.nullable(), order: z.enum(['newest', 'oldest']) };
const count = z.number().int().nonnegative();
const size = count.nullable();
const date = z.iso.datetime().nullable();
export const photoVersion = z.enum(['thumb', 'medium', 'large', 'original']);
export type PhotoVersion = z.infer<typeof photoVersion>;
const version = z.object({ width: size, height: size, bytes: size, type: z.string().nullable() });
export const photoAsset = z.object({
  id: recordId, created: date, added: date, width: size, height: size,
  kind: z.enum(['photo', 'video', 'live']), favorite: z.boolean(), filename: z.string().nullable(),
  duration: z.number().nonnegative().nullable(), versions: z.partialRecord(photoVersion, version),
});
export type PhotoAsset = z.infer<typeof photoAsset>;
export type PhotoVersionMetadata = z.infer<typeof version>;

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
  photoLibraries: {
    input: z.null(),
    output: success({ libraries: z.array(z.object({ id: recordId, name: z.string(), kind: z.enum(['personal', 'shared']) })) }),
  },
  photoIndexStatus: {
    input: z.object(library).strict(),
    output: success({ state: z.enum(['empty', 'indexing', 'ready', 'error']), indexed: count, total: size, updatedAt: date, error: z.string().nullable() }),
  },
  photoAssets: {
    input: z.object({ ...page, offset: count, limit: z.number().int().min(1).max(200) }).strict(),
    output: success({ total: count, assets: z.array(photoAsset).max(200) }),
  },
  photoMonths: {
    input: z.object(page).strict(),
    output: success({ months: z.array(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), offset: count, count })) }),
  },
  photoAlbums: {
    input: z.object(library).strict(),
    output: success({ albums: z.array(z.object({ id: recordId, name: z.string(), kind: z.enum(['smart', 'album', 'folder']), parent: recordId.nullable(), count: size })) }),
  },
  photoVersionTickets: {
    input: z.object({ ...library, ids: z.array(recordId).min(1).max(200), version: photoVersion }).strict(),
    output: success({ tickets: z.record(recordId, id.nullable()) }),
  },
};
