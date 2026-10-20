import type { Source } from './ports.js';

/** Sync state is evidence, not an assessment of local content freshness. */
export function provenance(source: Source, at: string) {
  return {
    vaultId: source.id, vaultName: source.name, localObservedAt: at,
    lastSuccessfulSync: source.lastSuccess,
    sync: { connected: source.cloudConnected, enabled: source.enabled, phase: source.phase, failure: source.failure },
    syncTimestampMeaning: 'Time recorded after the host sync operation returned successfully; null means no successful sync recorded (never synced or history unknown).',
    delivery: 'Local observation only; a sync timestamp is not proof of these bytes in iCloud or on a device.',
  };
}
