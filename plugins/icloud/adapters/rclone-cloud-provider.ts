import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RecoveryCopies, BACKUP_LIMIT } from './recovery-copies.ts';
export { BACKUP_LIMIT, treeSize } from './recovery-copies.ts';
import { CloudError, activity } from '../core/ports.ts';
import type { CloudProvider, CloudFolder, Connection, Mirror, ProgressReporter } from '../core/ports.ts';
import type { CommandRunner, RcCall } from './rclone-process.ts';

const encode = (path: string) => Buffer.from(path).toString('base64url');
function decode(id: string): string {
  const path = Buffer.from(id, 'base64url').toString('utf8');
  if (encode(path) !== id || !path || path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(s => !s || s === '.' || s === '..')) throw new CloudError('invalid_selection');
  return path;
}
export function syncArguments(remote: string, local: string, baseline: string, initial: boolean): string[] {
  return ['bisync', remote, local, '--workdir', baseline, '--conflict-resolve', 'none', '--conflict-loser', 'num',
    '--conflict-suffix', 'icloud-conflict,bb-conflict', '--compare', 'size,modtime', '--max-delete', '50',
    '--check-sync=true', '--create-empty-src-dirs', '--max-transfer', '256M', '--cutoff-mode', 'hard', ...(initial ? ['--resync'] : [])];
}
export class RcloneCloudProvider implements CloudProvider {
  private continuation: string | null = null;
  constructor(private readonly root: string, private readonly rc: RcCall,
    private readonly run: CommandRunner, private readonly availability: () => Promise<void>,
    private readonly shutdown: () => Promise<void>, private readonly limit = BACKUP_LIMIT) {}
  checkAvailability() { return this.availability(); }
  async verifyConnection() {
    await this.rc('fscache/clear', {});
    await this.rc('operations/list', { fs: 'icloud:', remote: '', opt: { dirsOnly: true } });
  }
  private async authResult(result: any): Promise<Connection> {
    // Provider help/error/defaults may contain secrets. Return fixed domain copy only.
    if (result?.Error) throw new CloudError('authentication');
    if (result?.State === '') {
      this.continuation = null;
      // A successful harmless read proves the session works before showing connected.
      await this.verifyConnection();
      return { connected: true };
    }
    if (typeof result?.State === 'string' && ['config_2fa', 'config_2fa_sms'].includes(result?.Option?.Name)) {
      this.continuation = result.State; return { connected: false, challenge: 'verification_code' };
    }
    throw new CloudError('unavailable');
  }
  async connect(credentials: { account: string; password: string }) {
    this.continuation = null;
    // Retain account binding across disconnect so old local data cannot be sent to another account.
    const existing = await this.rc('config/listremotes', {});
    if (existing.remotes?.includes('icloud')) {
      const config = await this.rc('config/get', { name: 'icloud' });
      if (config.apple_id?.toLowerCase() !== credentials.account.toLowerCase()) throw new CloudError('invalid_selection');
    }
    const result = await this.rc('config/create', { name: 'icloud', type: 'iclouddrive',
      parameters: { service: 'drive', apple_id: credentials.account, password: credentials.password },
      opt: { nonInteractive: true, obscure: true } });
    return this.authResult(result);
  }
  async answerChallenge(answer: string) {
    if (!this.continuation || !/^\d{6}$/.test(answer)) throw new CloudError('authentication');
    const result = await this.rc('config/update', { name: 'icloud', parameters: {},
      opt: { nonInteractive: true, continue: true, state: this.continuation, result: answer } });
    return this.authResult(result);
  }
  async listFolders(parent: string | null): Promise<CloudFolder[]> {
    const path = parent === null ? '' : decode(parent);
    const result = await this.rc('operations/list', { fs: 'icloud:', remote: path, opt: { dirsOnly: true } });
    if (!Array.isArray(result.list)) throw new CloudError('sync_failed');
    return result.list.map((item: any) => {
      if (!item.IsDir || typeof item.Name !== 'string' || !item.Name || /[\x00-\x1f\x7f/]/.test(item.Name) || item.Name === '.' || item.Name === '..') throw new CloudError('invalid_selection');
      const full = path ? `${path}/${item.Name}` : item.Name;
      return { id: encode(full), name: item.Name, ancestors: path ? path.split('/').map((_, i, all) => encode(all.slice(0, i + 1).join('/'))) : [] };
    });
  }
  localFolder(mirror: Mirror) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(mirror.id)) throw new CloudError('invalid_selection');
    return join(this.root, 'mirrors', mirror.id);
  }
  private remote(mirror: Mirror) { return `icloud:${decode(mirror.folder.id)}`; }
  private async backup(mirror: Mirror, report?: ProgressReporter) {
    const copies = new RecoveryCopies(join(this.root, 'backups'), this.run, this.limit);
    await copies.capture(mirror.id, this.remote(mirror), this.localFolder(mirror), report);
  }
  private async bisync(mirror: Mirror, initial: boolean, report?: ProgressReporter) {
    report?.(activity('checking'));
    await this.run(syncArguments(this.remote(mirror), this.localFolder(mirror), join(this.root, 'baselines', mirror.id), initial), false, report ? stats => {
      const complete = stats.totalFiles !== null && stats.files >= stats.totalFiles && (stats.totalBytes === null || stats.bytes >= stats.totalBytes);
      // Preserve measured completion counters for diagnostics before returning to finishing activity.
      report({ ...stats, stage: stats.bytes || stats.totalBytes || stats.totalFiles ? 'transferring' : 'checking' });
      if (complete) report(activity('verifying'));
    } : undefined);
    report?.(activity('verifying'));
  }
  async prepareMirror(mirror: Mirror, report?: ProgressReporter) {
    const local = this.localFolder(mirror); const baseline = join(this.root, 'baselines', mirror.id);
    await mkdir(local, { recursive: true, mode: 0o700 }); await mkdir(baseline, { recursive: true, mode: 0o700 });
    // Never use initial resync to recover existing data or a partial attempt.
    if ((await readdir(local)).length || (await readdir(baseline)).length || mirror.initialized) throw new CloudError('recovery_required');
    await writeFile(join(baseline, 'preparing'), '', { flag: 'wx', mode: 0o600 });
    await this.backup(mirror, report);
    await this.bisync(mirror, true, report);
    await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
  }
  async synchronize(mirror: Mirror, report?: ProgressReporter) {
    const baseline = join(this.root, 'baselines', mirror.id);
    try { if (!mirror.initialized || await readFile(join(baseline, 'initialized'), 'utf8') !== '1') throw new Error(); }
    catch { throw new CloudError('recovery_required'); }
    await this.backup(mirror, report);
    await this.bisync(mirror, false, report);
  }
  async disconnect() {
    this.continuation = null;
    const { remotes } = await this.rc('config/listremotes', {});
    if (remotes?.includes('icloud')) await this.rc('config/unset', { name: 'icloud', keys: ['password', 'cookies', 'trust_token', '_auth_session'] });
    await this.rc('fscache/clear', {});
  }
  stop() { return this.shutdown(); }
}
