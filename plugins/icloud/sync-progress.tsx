import type { SyncProgress } from './core/ports.ts';
const labels = {
  checking: 'Checking for changes', backing_up_cloud: 'Saving iCloud recovery copy', backing_up_local: 'Saving BB recovery copy',
  saving_recovery: 'Saving recovery versions', transferring: 'Transferring files', verifying: 'Finishing sync checks',
};
export function progressPercent(progress: SyncProgress): number | null {
  const total = progress.totalBytes ?? progress.totalFiles;
  const done = progress.totalBytes !== null ? progress.bytes : progress.files;
  return total !== null && total > 0 && done <= total ? Math.floor(done / total * 100) : null;
}
export function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: index ? 1 : 0 }).format(bytes)} ${units[index]}`;
}
export function SyncProgressView({ progress, folderName }: { progress: SyncProgress | null | undefined; folderName: string }) {
  const value: SyncProgress = progress ?? { stage: 'checking', bytes: 0, totalBytes: null, files: 0, totalFiles: null };
  const percent = progressPercent(value); const label = labels[value.stage];
  const details = [value.totalBytes !== null ? `${formatBytes(value.bytes)} of ${formatBytes(value.totalBytes)}` : value.bytes ? formatBytes(value.bytes) : null,
    value.totalFiles !== null ? `${value.files} of ${value.totalFiles} ${value.totalFiles === 1 ? 'file' : 'files'}` : value.files ? `${value.files} ${value.files === 1 ? 'file' : 'files'}` : null].filter(Boolean).join(' · ');
  return <div className="pa-icloud__progress">
    <div className="pa-icloud__progress-heading"><span role="status">{label}</span>{percent !== null && <span aria-hidden>{percent}%</span>}</div>
    <div role="progressbar" aria-label={`${label}: ${folderName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={details || label}
      className={`pa-icloud__progress-track${percent === null ? ' pa-icloud__progress-track--indeterminate' : ''}`}>
      <div className="pa-icloud__progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
    {details && <div className="pa-icloud__progress-details">{details}</div>}
    {percent === 100 && value.stage === 'transferring' && <div className="pa-icloud__progress-details">Transfers complete. Waiting for sync checks.</div>}
  </div>;
}
