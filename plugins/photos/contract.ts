import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const appleState = z.enum(['disconnected', 'shared', 'unavailable']);
const id = z.string().uuid();
const entry = z.object({ name: z.string(), directory: z.boolean(), size: z.number().int().nonnegative().nullable() });
const group = z.object({ handle: z.string(), did: z.string().nullable() });
const error = z.object({ ok: z.literal(false), error: z.string() });
const success = <T extends z.ZodRawShape>(fields: T) => z.union([error, z.object({ ok: z.literal(true), ...fields })]);
const count = z.number().int().nonnegative().safe();
const recordId = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/);
const date = z.iso.datetime().nullable();
const scope = z.object({ library: recordId, album: recordId.nullable(), order: z.enum(['newest', 'oldest']) }).strict();
const version = z.enum(['thumb', 'medium', 'large', 'original']);
const resource = z.object({ width: count.nullable(), height: count.nullable(), bytes: count.nullable(), type: z.string().nullable() });
const asset = z.object({
  id: recordId, created: date, added: date,
  width: count.nullable(), height: count.nullable(),
  kind: z.enum(['photo', 'video', 'live']), favorite: z.boolean(), filename: z.string().nullable(),
  duration: z.number().nonnegative().nullable(), versions: z.partialRecord(version, resource),
});
const month = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), offset: count, count });
const album = z.object({
  id: recordId, name: z.string(), kind: z.enum(['smart', 'album', 'folder']), parent: recordId.nullable(), count: count.nullable(),
});
const indexStatus = z.object({
  state: z.enum(['empty', 'indexing', 'ready', 'error']), indexed: count, total: count.nullable(),
  updatedAt: date, error: z.string().nullable(),
});

export type Asset = z.infer<typeof asset>;
export type PhotoVersion = z.infer<typeof version>;
export type PhotoMonth = z.infer<typeof month>;
export type PhotoAlbum = z.infer<typeof album>;
export type PhotoIndex = z.infer<typeof indexStatus>;
export type PhotoScope = z.infer<typeof scope>;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({ apple: appleState, grain: z.string().nullable(), group: group.nullable() }) },
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
  photoLibraries: { input: z.null(), output: success({
    libraries: z.array(z.object({ id: recordId, name: z.string(), kind: z.enum(['personal', 'shared']) })),
  }) },
  photoIndexStatus: { input: z.object({ library: recordId }).strict(), output: success(indexStatus.shape) },
  photoAssets: { input: scope.extend({ offset: count, limit: count.min(1).max(200) }).strict(),
    output: success({ total: count, assets: z.array(asset).max(200) }) },
  photoMonths: { input: scope, output: success({ months: z.array(month) }) },
  photoAlbums: { input: z.object({ library: recordId }).strict(), output: success({ albums: z.array(album) }) },
  photoVersionTickets: { input: z.object({ library: recordId, ids: z.array(recordId).min(1).max(200), version }).strict(),
    output: success({ tickets: z.record(recordId, id.nullable()) }) },
  checkGrain: { input: z.null(), output: z.union([error, z.object({ ok: z.literal(true) })]) },
});
