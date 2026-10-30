import { z } from 'zod';

export const RCLONE_LOG_LIMITS = { fileBytes: 1024 * 1024, files: 4, queueRecords: 256, recordBytes: 4096 } as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const category = z.enum(['timeout', 'connection_reset', 'connection_refused', 'dns', 'authentication', 'rate_limited', 'http', 'unknown']);
export const traceEntrySchema = z.object({
  at: z.iso.datetime(), commandId: z.uuid(), elapsedMs: count,
  event: z.enum(['command_start', 'command_end', 'command_timeout', 'message', 'stats', 'retry', 'listing', 'comparing', 'invalid_record']),
  level: z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']).optional(),
  component: z.enum(['bisync', 'icloud', 'accounting', 'operations', 'sync', 'pacer', 'http', 'unknown']).optional(),
  line: count.optional(), category: category.optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  stats: z.object({
    bytes: count.optional(), totalBytes: count.optional(), checks: count.optional(), totalChecks: count.optional(),
    transfers: count.optional(), totalTransfers: count.optional(), errors: count.optional(), deletes: count.optional(),
    checking: count.optional(), transferring: count.optional(),
    elapsedTime: z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER).optional(),
    speed: z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER).optional(),
    retryError: z.boolean().optional(), fatalError: z.boolean().optional(),
  }).strict().optional(),
  timeoutMs: count.optional(), outcome: z.enum(['succeeded', 'failed']).optional(),
  evidence: z.enum(['command_exit', 'command_timeout', 'command_signal', 'command_start', 'command_output_limit', 'command_stopped']).optional(),
  exitCode: z.number().int().min(0).max(10).nullable().optional(),
}).strict();
export type TraceEntry = z.infer<typeof traceEntrySchema>;
export const traceQuerySchema = z.object({ limit: z.number().int().min(1).max(500).default(100) }).strict();
export const traceSnapshotSchema = z.object({
  available: z.boolean(), failure: z.literal('unavailable').nullable(), incomplete: z.boolean(),
  droppedRecords: count, queuedRecords: count, entries: z.array(traceEntrySchema).max(500),
  limits: z.object({ fileBytes: z.literal(RCLONE_LOG_LIMITS.fileBytes), files: z.literal(RCLONE_LOG_LIMITS.files), queueRecords: z.literal(RCLONE_LOG_LIMITS.queueRecords), recordBytes: z.literal(RCLONE_LOG_LIMITS.recordBytes) }).strict(),
}).strict();
export type TraceSnapshot = z.infer<typeof traceSnapshotSchema>;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;

// Projection, not a regex-redacted copy: no raw message, object, name, URL,
// request, response, exception or arbitrary extra field ever reaches storage.
export function projectRcloneRecord(record: unknown): Omit<TraceEntry, 'at' | 'commandId' | 'elapsedMs'> {
  const value = object(record);
  if (!value) return { event: 'invalid_record' };
  const out: Omit<TraceEntry, 'at' | 'commandId' | 'elapsedMs'> = { event: 'message' };
  if (['debug', 'info', 'notice', 'warning', 'error', 'critical'].includes(value.level as string)) out.level = value.level as TraceEntry['level'];
  // Source metadata is emitted by rclone. Keep a fixed component and numeric
  // line only, never even a provider-supplied source filename.
  if (typeof value.source === 'string' && value.source.length < 160) {
    const match = /^(bisync|backend\/iclouddrive|fs\/accounting|fs\/operations|fs\/sync|lib\/pacer|lib\/rest)\/[a-zA-Z0-9_-]+\.go:([1-9][0-9]{0,5})$/.exec(value.source);
    const components = { bisync: 'bisync', 'backend/iclouddrive': 'icloud', 'fs/accounting': 'accounting', 'fs/operations': 'operations', 'fs/sync': 'sync', 'lib/pacer': 'pacer', 'lib/rest': 'http' } as const;
    out.component = match ? components[match[1] as keyof typeof components] : 'unknown';
    if (match) out.line = Number(match[2]);
  }
  const stats = object(value.stats);
  if (stats) {
    out.event = 'stats'; out.stats = {};
    for (const key of ['bytes', 'totalBytes', 'checks', 'totalChecks', 'transfers', 'totalTransfers', 'errors', 'deletes'] as const) if (integer(stats[key])) out.stats[key] = stats[key];
    for (const key of ['speed', 'elapsedTime'] as const) if (number(stats[key])) out.stats[key] = stats[key];
    for (const key of ['retryError', 'fatalError'] as const) if (typeof stats[key] === 'boolean') out.stats[key] = stats[key];
    for (const key of ['checking', 'transferring'] as const) if (Array.isArray(stats[key])) out.stats[key] = stats[key].length;
  }
  // These labels describe recognized error text, not a provider audit or proof
  // that a failed write was not applied. Unknown text stays unknown.
  const messages = [value.msg, stats?.lastError].filter((s): s is string => typeof s === 'string' && s.length <= 64 * 1024);
  const text = messages.join('\n');
  const status = /\b(?:status code[:= ]+|HTTP(?: error| status)?[:= ]+)([1-5][0-9]{2})\b/i.exec(text);
  if (status) out.httpStatus = Number(status[1]);
  if (/\b(?:context deadline exceeded|i\/o timeout|TLS handshake timeout|Client\.Timeout exceeded)\b/i.test(text)) out.category = 'timeout';
  else if (/\bconnection reset by peer\b/i.test(text)) out.category = 'connection_reset';
  else if (/\bconnection refused\b/i.test(text)) out.category = 'connection_refused';
  else if (/\b(?:no such host|temporary failure in name resolution)\b/i.test(text)) out.category = 'dns';
  else if (messages.includes('trust token expired, please reauth')) out.category = 'authentication';
  else if (out.httpStatus === 429 || /^pacer: Rate limited, /i.test(text)) out.category = 'rate_limited';
  else if (out.httpStatus) out.category = 'http';
  else if (['warning', 'error', 'critical'].includes(out.level ?? '') || typeof stats?.lastError === 'string') out.category = 'unknown';
  if (!stats && /^(?:pacer: )?(?:low level retry [0-9]+\/[0-9]+|Attempt [0-9]+\/[0-9]+ failed)\b/i.test(text)) out.event = 'retry';
  else if (!stats && out.component === 'bisync' && /^(?:Listing Path[12]|Building (?:Path[12]|current) listing|Reading (?:Path[12]|current|prior) listing)/.test(text)) out.event = 'listing';
  else if (!stats && out.component === 'bisync' && /^Comparing listings\b/.test(text)) out.event = 'comparing';
  return out;
}
