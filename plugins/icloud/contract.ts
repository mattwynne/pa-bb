import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { diagnosticsSchema } from './core/diagnostics.js';
const folder = z.object({ id: z.string(), name: z.string(), ancestors: z.array(z.string()) });
const progress = z.object({ stage: z.enum(['checking', 'backing_up_cloud', 'backing_up_local', 'saving_recovery', 'transferring', 'verifying']), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), files: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), totalFiles: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), reusedFiles: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const mirror = z.object({ id: z.string(), folder, initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable(), progress: progress.nullable().optional() });
export const statusSchema = z.object({ connected: z.boolean(), challenge: z.enum(['verification_code', 'trusted_device']).nullable(), mirrors: z.array(mirror), available: z.boolean(), prerequisite: z.string().nullable() });
const id = z.object({ id: z.string().min(1).max(64) }).strict();
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  diagnostics: { input: z.null(), output: diagnosticsSchema },
  browse: { input: z.object({ parent: z.string().max(4096).nullable() }).strict(), output: z.array(folder) },
  select: { input: z.object({ folderId: z.string().min(1).max(4096) }).strict(), output: statusSchema },
  enable: { input: id, output: statusSchema }, rebuild: { input: id, output: statusSchema }, pause: { input: id, output: statusSchema },
  disconnect: { input: z.null(), output: statusSchema },
  inventory: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string(), localFolder: z.string(), phase: z.string(), lastSuccess: z.string().nullable() })) },
});
