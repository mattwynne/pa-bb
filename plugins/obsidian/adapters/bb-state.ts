import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { VaultError } from '../core/ports.ts';
import type { StateRepository, Diagnose } from '../core/ports.ts';
// Kept only to inspect move IDs submitted by previous builds.
const moveRecordSchema = z.object({
  operationId: z.string().uuid(), vaultId: z.string(), path: z.string(), destination: z.string(),
  expectedHash: z.string().optional(), root: z.string().optional(),
  project: z.enum(['standalone', 'paired']).optional(), directory: z.literal(true).optional(),
  verifyLinks: z.literal(true).optional(), refused: z.boolean().optional(),
  verification: z.object({ state: z.string() }).passthrough().optional(),
  repairs: z.array(z.object({ outcome: z.string() }).passthrough()).max(64),
}).passthrough();
const schema = z.object({ moves: z.array(moveRecordSchema).max(20).optional(), revision: z.number().int().nonnegative(), vaultIds: z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(20), names: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(512)).optional(), unconfirmedRevision: z.number().int().nonnegative().optional(), pending: z.array(z.object({ operationId: z.string().uuid(), vaultId: z.string(), path: z.string().max(1024), at: z.string().datetime(), kind: z.enum(['save', 'resolution']).optional() }).strict()).max(100).optional() }).strict();
export function bbState(bb: BbPluginApi, diagnose: Diagnose): StateRepository {
  return {
    async load() { try { const value = await bb.storage.kv.get('connected-vaults'); return value === undefined ? undefined : schema.parse(value); } catch { diagnose('state', 'unavailable'); throw new VaultError('state_unavailable', 'Settings could not be loaded. Ask the operator to inspect plugin storage; do not reset it.', true); } },
    async save(value) { try { await bb.storage.kv.set('connected-vaults', schema.parse(value)); } catch { diagnose('state', 'unavailable'); throw new VaultError('state_unavailable', 'Settings could not be saved. Keep the existing plugin storage and check again.', true); } },
  };
}
