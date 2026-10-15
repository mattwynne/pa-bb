import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { VaultError } from '../core/ports.ts';
import type { StateRepository, Diagnose } from '../core/ports.ts';
const schema = z.object({ revision: z.number().int().nonnegative(), vaultIds: z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(20), pending: z.array(z.object({ operationId: z.string().uuid(), vaultId: z.string(), path: z.string().max(1024), at: z.string().datetime() }).strict()).max(100).optional() }).strict();
export function bbState(bb: BbPluginApi, diagnose: Diagnose): StateRepository {
  return {
    async load() { try { const value = await bb.storage.kv.get('connected-vaults'); return value === undefined ? undefined : schema.parse(value); } catch { diagnose('state', 'unavailable'); throw new VaultError('state_unavailable', 'Settings could not be loaded. Ask the operator to inspect plugin storage; do not reset it.', true); } },
    async save(value) { try { await bb.storage.kv.set('connected-vaults', schema.parse(value)); } catch { diagnose('state', 'unavailable'); throw new VaultError('state_unavailable', 'Settings could not be saved. Keep the existing plugin storage and check again.', true); } },
  };
}
