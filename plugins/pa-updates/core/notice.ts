import type { ApplicationStatus } from './application-model.ts';

/** Latest discovery is independent of the saved review and its receipts. */
export function hasFreshOffers(state: ApplicationStatus, now = Date.now()): boolean {
  return !state.failure && !state.applying && !state.checking && !state.job?.syncReserved &&
    !!state.offers?.available && now - Date.parse(state.offers.checkedAt) < 6 * 60 * 60 * 1000;
}
