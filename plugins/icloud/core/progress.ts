import type { SyncProgress } from './ports.ts';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const total = (value: unknown, done: number) => count(value) && value > 0 && value >= done ? value : null;
export function progressSnapshot(value: SyncProgress): SyncProgress | null {
  if (!value || !['checking', 'backing_up_cloud', 'backing_up_local', 'saving_recovery', 'transferring', 'verifying'].includes(value.stage) || !count(value.bytes) || !count(value.files)) return null;
  // Explicit projection keeps accidental provider-specific fields out of status.
  return { stage: value.stage, bytes: value.bytes, totalBytes: total(value.totalBytes, value.bytes), files: value.files, totalFiles: total(value.totalFiles, value.files) };
}
