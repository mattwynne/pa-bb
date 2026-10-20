import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { diagnosticsSchema, historyQuerySchema } from './core/diagnostics.js';
import { noteRpcContract, searchCapabilitySchema } from './core/note-contract.ts';
const folder = z.object({ id: z.string(), name: z.string(), ancestors: z.array(z.string()) });
const progress = z.object({ stage: z.enum(['checking', 'backing_up_cloud', 'backing_up_local', 'saving_recovery', 'transferring', 'verifying']), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), files: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), totalFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), reusedFiles: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const local = z.object({ available: z.boolean(), reason: z.enum(['ownership', 'recovery_required', 'source_changed']).nullable(), pendingAgeMs: z.number().int().nonnegative().nullable(), applicationBlocker: z.enum(['application_uncertain', 'native_recovery']).nullable() }).strict();
const mirror = z.object({ id: z.string(), folder, initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable(), blocker: z.enum(['reconnect', 'configuration', 'capacity', 'initialization', 'rebuild']).nullable(), retryPending: z.boolean(), recovering: z.boolean(), progress: progress.nullable().optional(), local });
export const statusSchema = z.object({ updatePause: z.object({ version: z.literal(1), jobId: z.string().uuid().nullable(), manualRecovery: z.boolean().optional() }).optional(), search: searchCapabilitySchema.optional(), noteAccessVersion: z.literal(2).nullable(), connected: z.boolean(), challenge: z.enum(['verification_code', 'trusted_device']).nullable(), mirrors: z.array(mirror), available: z.boolean(), prerequisite: z.string().nullable() });
const id = z.object({ id: z.string().min(1).max(64) }).strict();
const pauseOrResume = z.union([id, z.object({ updateJob: z.string().uuid() }).strict()]);
export const rpcContract = defineRpcContract({
  ...noteRpcContract,
  status: { input: z.null(), output: statusSchema },
  diagnostics: { input: z.union([z.null(), historyQuerySchema]), output: diagnosticsSchema },
  browse: { input: z.object({ parent: z.string().max(4096).nullable() }).strict(), output: z.array(folder) },
  select: { input: z.object({ folderId: z.string().min(1).max(4096) }).strict(), output: statusSchema },
  enable: { input: pauseOrResume, output: statusSchema }, retry: { input: id, output: statusSchema }, rebuild: { input: id, output: statusSchema }, pause: { input: pauseOrResume, output: statusSchema },
  disconnect: { input: z.null(), output: statusSchema },
  inventory: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string(), phase: z.string(), lastSuccess: z.string().nullable(), local })) },
});
