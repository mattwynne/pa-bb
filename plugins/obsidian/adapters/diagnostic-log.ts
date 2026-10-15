import type { Diagnose } from '../core/ports.ts';
const categories = new Set(['unavailable', 'busy', 'uncertain', 'source_unavailable', 'not_connected', 'invalid_path', 'unsupported', 'conflict', 'capacity', 'cancelled', 'operation_reused', 'operation_expired', 'limit']);
export function diagnosticLogger(warn: (message: string) => void): Diagnose { return (stage, category) => warn(`Obsidian ${['catalog', 'rpc', 'state', 'parse', 'tool'].includes(stage) ? stage : 'unknown'} ${categories.has(category) ? category : 'unknown'}`); }
