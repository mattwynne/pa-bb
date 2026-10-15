import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
const path = z.string().min(1).max(1024);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const target = { mirrorId: id, revision, path };
const failure = z.object({ ok: z.literal(false), category: z.enum(['busy', 'unavailable', 'source_unavailable', 'not_connected', 'invalid_path', 'unsupported', 'conflict', 'capacity', 'cancelled', 'uncertain', 'operation_reused', 'operation_expired']), nextAction: z.string().max(200) }).strict();
const receipt = z.object({ operationId: z.string().uuid(), mirrorId: id, path, at: z.string(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']), hash: z.string().regex(/^[a-f0-9]{64}$/), previousHash: z.string().nullable() }).strict();
const result = <T extends z.ZodType>(value: T) => z.union([z.object({ ok: z.literal(true), value }).strict(), failure]);
// Copied into the independent consumer package, never imported across plugin roots.
export const noteRpcContract = {
  noteConfigure: { input: z.object({ revision, mirrorIds: z.array(id).max(20) }).strict(), output: result(z.object({ revision }).strict()) },
  noteList: { input: z.object({ mirrorId: id, revision }).strict(), output: result(z.object({ paths: z.array(path).max(10000), incomplete: z.boolean(), warnings: z.array(z.string().max(64)).max(10) }).strict()) },
  noteRead: { input: z.object(target).strict(), output: result(z.object({ text: z.string().max(1024 * 1024), hash: z.string().regex(/^[a-f0-9]{64}$/), readAt: z.string(), complete: z.literal(true) }).strict()) },
  noteCommit: { input: z.object({ ...target, operationId: z.string().uuid(), kind: z.enum(['create', 'replace']), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), text: z.string().max(1024 * 1024) }).strict(), output: result(receipt) },
  noteReceipts: { input: z.object({ mirrorId: id, revision, operationId: z.string().uuid().optional(), path: path.optional(), since: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(), output: result(z.array(receipt).max(100)) },
} as const;
