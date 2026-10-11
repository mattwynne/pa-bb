import { CloudError, emptyState } from '../core/ports.ts';
import type { CloudProvider, Connection, CloudFolder, Mirror, State, StateRepository, Failure } from '../core/ports.ts';
export class MemoryState implements StateRepository {
  value: State = emptyState();
  async load() { return structuredClone(this.value); }
  async save(state: State) { this.value = structuredClone(state); }
}
export class FakeCloudProvider implements CloudProvider {
  prepared = 0; synced = 0; disconnected = 0; fail: Failure | null = null;
  pending: Promise<void> | null = null;
  async checkAvailability() {}
  async verifyConnection() {}
  async connect(): Promise<Connection> { return { connected: false, challenge: 'verification_code' }; }
  async answerChallenge(): Promise<Connection> { return { connected: true }; }
  async listFolders(parent: string | null): Promise<CloudFolder[]> { return parent ? [{ id: 'child', name: 'Child', ancestors: ['test'] }] : [{ id: 'test', name: 'Test Vault', ancestors: [] }, { id: 'other', name: 'Other Vault', ancestors: [] }]; }
  async prepareMirror() { this.prepared++; }
  async synchronize() { this.synced++; await this.pending; if (this.fail) throw new CloudError(this.fail); }
  async disconnect() { this.disconnected++; }
  async stop() {}
  localFolder(mirror: Mirror) { return `/synthetic/mirrors/${mirror.id}`; }
}
