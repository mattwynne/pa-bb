import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
const path = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.literal(2);
const target = { version, mirrorId: id, revision, path };
const failure = z.object({ ok: z.literal(false), category: z.enum(['busy', 'unavailable', 'source_unavailable', 'not_connected', 'invalid_path', 'unsupported', 'conflict', 'capacity', 'cancelled', 'uncertain', 'operation_reused', 'operation_expired']), nextAction: z.string().max(200) }).strict();
const save = z.object({ kind: z.literal('save'), operationId: z.string().uuid(), mirrorId: id, path, at: z.string(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']), hash, previousHash: hash.nullable() }).strict();
const resolution = z.object({ kind: z.literal('resolution'), operationId: z.string().uuid(), mirrorId: id, path, at: z.string(), outcome: z.enum(['saved_locally_pending_sync', 'adopted_content', 'adopted_absence']), hash: hash.nullable() }).strict();
const result = <T extends z.ZodType>(value: T) => z.union([z.object({ ok: z.literal(true), value }).strict(), failure]);
const bytes = z.object({ text: z.string().max(1024 * 1024), hash, readAt: z.string(), complete: z.literal(true) }).strict();
// Copied into the independent consumer package, never imported across plugin roots.
export const noteRpcContract = {
  noteConfigure: { input: z.object({ version, revision, mirrorIds: z.array(id).max(20) }).strict(), output: result(z.object({ revision }).strict()) },
  noteList: { input: z.object({ version, mirrorId: id, revision }).strict(), output: result(z.object({ paths: z.array(path).max(10000), incomplete: z.boolean(), warnings: z.array(z.string().max(64)).max(10) }).strict()) },
  noteRead: { input: z.object({ ...target, selector: z.object({ version: z.literal('incoming'), token: z.string().uuid() }).strict().optional() }).strict(), output: result(z.union([bytes, z.object({ absent: z.literal(true) }).strict(), bytes.extend({ absent: z.literal(false) })])) },
  noteCommit: { input: z.object({ ...target, operationId: z.string().uuid(), kind: z.enum(['create', 'replace']), expectedHash: hash.nullable(), text: z.string().max(1024 * 1024) }).strict(), output: result(save.omit({ kind: true })) },
  noteReceipts: { input: z.object({ version, mirrorId: id, revision, operationId: z.string().uuid().optional(), path: path.optional(), since: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(), output: result(z.array(z.union([save, resolution])).max(100)) },
  noteInspectConflict: { input: z.object(target).strict(), output: result(z.object({ token: z.string().uuid(), logicalHash: hash, incomingHash: hash.nullable(), incomingAbsent: z.boolean() }).strict().nullable()) },
  noteResolveConflict: { input: z.object({ ...target, operationId: z.string().uuid(), token: z.string().uuid(), expectedLogicalHash: hash, expectedIncomingHash: hash.nullable(), choice: z.enum(['keep_local', 'accept_incoming', 'replace']), text: z.string().max(1024 * 1024).optional() }).strict(), output: result(z.object({ outcome: z.enum(['saved_locally_pending_sync', 'adopted_content', 'adopted_absence']), hash: hash.nullable() }).strict()) },
} as const;
