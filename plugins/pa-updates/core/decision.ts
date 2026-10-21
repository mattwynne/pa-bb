import type { Assessment } from './application-model.ts';

/** Installed-byte provenance and canonical source work remain separate facts. */
export const localDecision = (row: Pick<Assessment, 'local' | 'development'>): 'automatic' | 'choose' | 'unverified' =>
  row.local === 'unknown' || row.development === 'unknown' ? 'unverified' : row.local === 'custom' || row.development === 'unpublished' ? 'choose' : 'automatic';

/** The server supplies the decision. The fallback covers older saved reviews. */
export const reviewDecision = (row: Assessment) => row.decision ?? localDecision(row);
