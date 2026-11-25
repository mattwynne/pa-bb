import { XeroError } from './diagnostic.ts';
// Preserve the initial connection's requested permissions. Broader access is owner-selected, never silently added on upgrade.
export const SCOPES = Object.freeze(['offline_access', 'accounting.invoices', 'accounting.contacts.read', 'accounting.settings.read',
  'accounting.payments', 'accounting.attachments', 'accounting.banktransactions.read',
  'accounting.reports.banksummary.read', 'accounting.reports.trialbalance.read',
  'accounting.reports.profitandloss.read', 'accounting.reports.balancesheet.read']);
export function requestedScopes(additional = '', override = '') {
  const selected = override.trim() || additional.trim();
  if (selected.length > 4000 || !/^(?:[a-z][a-z0-9_.]*(?:\s+|$))*$/.test(selected)) throw new XeroError('configuration', 'scope_configuration', 'Use space-separated Xero OAuth scope names from the setup guide.');
  const scopes = new Set(override.trim() ? override.trim().split(/\s+/) : [...SCOPES, ...additional.trim().split(/\s+/).filter(Boolean)]);
  if (!scopes.has('offline_access')) throw new XeroError('configuration', 'scope_configuration', 'Exact scope overrides must include offline_access for a refreshable BB connection.');
  if (scopes.has('marketplace.billing')) throw new XeroError('configuration', 'scope_configuration', 'App Store billing uses its separate partner-access setting, not additional login scopes.');
  return [...scopes].filter(scope => !scope.endsWith('.read') || !scopes.has(scope.slice(0, -5)));
}
export function scopeGranted(required: string, granted: readonly string[]) {
  if (granted.includes(required) || (required.endsWith('.read') && granted.includes(required.slice(0, -5)))) return true;
  if (/^accounting\.(invoices|payments|banktransactions|manualjournals)(\.read)?$/.test(required)) return granted.includes('accounting.transactions') || (required.endsWith('.read') && granted.includes('accounting.transactions.read'));
  return /^accounting\.reports\.[a-z]+\.read$/.test(required) && granted.includes('accounting.reports.read');
}
