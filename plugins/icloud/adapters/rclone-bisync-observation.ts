// Pinned rclone v1.75.2 native log sites. JSON's `source` is set by rclone's
// slog handler from the caller, not taken from a backend's message/object.
// Never retain msg, object, cause, paths, or any other provider-supplied field.
export type BisyncDecision = 'retryable_abort' | 'resync_required_abort' | 'unknown_fatal';
export type BisyncReason = 'listing_failure';
const native = (record: unknown, source: string, message: string, color?: string): boolean => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (Object.keys(value).some(key => !['time', 'level', 'msg', 'source'].includes(key))) return false;
  return typeof value.time === 'string' && value.time.length <= 40 && !Number.isNaN(Date.parse(value.time)) &&
    value.level === 'error' && value.source === source &&
    (value.msg === message || (color !== undefined && value.msg === `\x1b[${color}m${message}\x1b[0m`));
};
export class RcloneBisyncObservation {
  private retry = false;
  private resync = false;
  private listing = false;
  private uncertain = false;
  observe(record: unknown | null) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) { this.uncertain = true; return; }
    if (native(record, 'bisync/operations.go:201', 'Bisync aborted. Error is retryable without --resync due to --resilient mode.', '33')) this.retry = true;
    if (native(record, 'bisync/operations.go:210', 'Bisync aborted. Must run --resync to recover.', '31')) this.resync = true;
    if (native(record, 'bisync/operations.go:313', 'There were errors while building listings. Aborting as it is too dangerous to continue.', '31')) this.listing = true;
    // A forged native marker with unexpected attributes is not proof; reject
    // rather than treating a separate valid marker as permission to retry.
    const value = record as Record<string, unknown>;
    if (typeof value.source === 'string' && ['bisync/operations.go:201', 'bisync/operations.go:210'].includes(value.source) &&
      !native(record, 'bisync/operations.go:201', 'Bisync aborted. Error is retryable without --resync due to --resilient mode.', '33') &&
      !native(record, 'bisync/operations.go:210', 'Bisync aborted. Must run --resync to recover.', '31')) this.uncertain = true;
  }
  decision(): BisyncDecision { return !this.uncertain && this.retry && !this.resync ? 'retryable_abort' : !this.uncertain && this.resync && !this.retry ? 'resync_required_abort' : 'unknown_fatal'; }
  reason(): BisyncReason | undefined { return !this.uncertain && this.listing ? 'listing_failure' : undefined; }
}
