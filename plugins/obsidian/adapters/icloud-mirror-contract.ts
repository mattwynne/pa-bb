import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
const path = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const filesystemIdentity = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const version = z.literal(1);
const target = { version, mirrorId: id, revision, path };
const failure = z.object({ ok: z.literal(false), category: z.enum(['busy', 'unavailable', 'source_unavailable', 'not_connected', 'invalid_path', 'unsupported', 'conflict', 'capacity', 'cancelled', 'uncertain', 'operation_reused', 'operation_expired']), nextAction: z.string().max(200) }).strict();
const save = z.object({ kind: z.literal('save'), operationId: z.string().uuid(), mirrorId: id, path, at: z.string(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']), hash, previousHash: hash.nullable() }).strict();
const resolution = z.object({ kind: z.literal('resolution'), operationId: z.string().uuid(), mirrorId: id, path, at: z.string(), outcome: z.enum(['saved_locally_pending_sync', 'adopted_content', 'adopted_absence']), hash: hash.nullable() }).strict();
const result = <T extends z.ZodType>(value: T) => z.union([z.object({ ok: z.literal(true), value }).strict(), failure]);
const segment = z.string().min(1).max(255).refine(value => !/[\/\\\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..');
const base64Limit = 4 * Math.ceil(1024 * 1024 / 3);
const content = z.base64().max(base64Limit).refine(value => value.length < base64Limit || value.endsWith('=='));
const bytes = z.object({ base64: content, hash, readAt: z.string(), complete: z.literal(true) }).strict();
// Copied into the independent consumer package, never imported across plugin roots.
export const mirrorFileContract = {
  mirrorDirectoryCapabilities: { input: z.null(), output: z.object({ mirrorDirectoryGrantVersion: z.literal(1).optional() }).strict() },
  mirrorDirectory: { input: z.object({ mirrorId: id, revision }).strict(), output: z.object({ directory: z.string().min(1) }).strict() },
  mirrorDirectoryGrant: { input: z.object({ mirrorId: id, revision }).strict(), output: z.object({ directory: z.string().min(1), rootDev: filesystemIdentity, rootIno: filesystemIdentity }).strict() },
  mirrorChildren: { input: z.object({ version, mirrorId: id, revision, folder: path }).strict(), output: result(z.object({ entries: z.array(z.object({ name: z.string().min(1).max(1024), kind: z.enum(['directory', 'file']) }).strict()).max(5000), incomplete: z.boolean() }).strict()) },
  mirrorConfigure: { input: z.object({ version, revision, mirrorIds: z.array(id).max(20) }).strict(), output: result(z.object({ revision }).strict()) },
  mirrorFindDirectories: { input: z.object({ version, mirrorId: id, revision, markerName: segment, exclude: z.array(segment).max(16) }).strict(), output: result(z.object({ directories: z.array(z.string().max(1024)).max(100), incomplete: z.boolean() }).strict()) },
  fileRead: { input: z.object({ ...target, selector: z.object({ version: z.literal('incoming'), token: z.string().uuid() }).strict().optional() }).strict(), output: result(z.union([bytes, z.object({ absent: z.literal(true) }).strict(), bytes.extend({ absent: z.literal(false) })])) },
  fileMove: { input: z.object({ ...target, destination: path, expectedHash: hash, operationId: z.string().uuid() }).strict(), output: result(z.object({ mirrorId: id, path, destination: path, expectedHash: hash, operationId: z.string().uuid(), at: z.string(), outcome: z.enum(['moved_locally_pending_sync', 'not_moved', 'uncertain']) }).strict()) },
  fileMoveReceipts: { input: z.object({ version, mirrorId: id, revision, operationId: z.string().uuid() }).strict(), output: result(z.array(z.object({ mirrorId: id, path, destination: path, expectedHash: hash, operationId: z.string().uuid(), at: z.string(), outcome: z.enum(['moved_locally_pending_sync', 'not_moved', 'uncertain']) }).strict()).max(1)) },
  fileCommit: { input: z.object({ ...target, operationId: z.string().uuid(), kind: z.enum(['create', 'replace']), expectedHash: hash.nullable(), base64: content }).strict(), output: result(save.omit({ kind: true })) },
  fileReceipts: { input: z.object({ version, mirrorId: id, revision, operationId: z.string().uuid().optional(), path: path.optional(), since: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(), output: result(z.array(z.union([save, resolution])).max(100)) },
  fileInspectConflict: { input: z.object(target).strict(), output: result(z.object({ token: z.string().uuid(), logicalHash: hash, incomingHash: hash.nullable(), incomingAbsent: z.boolean() }).strict().nullable()) },
  fileResolveConflict: { input: z.object({ ...target, operationId: z.string().uuid(), token: z.string().uuid(), expectedLogicalHash: hash, expectedIncomingHash: hash.nullable(), choice: z.enum(['keep_local', 'accept_incoming', 'replace']), base64: content.optional() }).strict(), output: result(z.object({ outcome: z.enum(['saved_locally_pending_sync', 'adopted_content', 'adopted_absence']), hash: hash.nullable() }).strict()) },
} as const;
