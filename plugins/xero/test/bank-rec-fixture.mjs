import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { SCOPES } from '../permissions.ts';
export const TENANT = '11111111-1111-4111-8111-111111111111', ACCOUNT = '44aaaa44-44aa-4444-8444-44aaaa444444';
export const account = { AccountID: ACCOUNT, Name: 'Example CAD Operating', Code: '090', Type: 'BANK', CurrencyCode: 'CAD', BankAccountNumber: 'SECRET_BANK_NUMBER', AccessToken: 'SECRET_ACCOUNT_TOKEN' };
export function capture(overrides = {}) {
  return { format: 'xero-bank-rec-capture', version: 1, capturedAt: new Date(Date.now() - 60_000).toISOString(), coverage: { visibleOnly: true, complete: false }, account: { AccountID: ACCOUNT, Name: account.Name, CurrencyCode: 'CAD', Code: '090' },
    url: `https://go.xero.com/BankRec/BankRec.aspx?accountId=${ACCOUNT}`,
    lines: Array.from({ length: 2 }, (_, i) => ({ date: '12 Sep 2026', payee: 'Example Vendor', spent: '10.00', received: null, reference: 'CARD-123', text: '12 Sep 2026 Example Vendor Spent 10.00 CARD-123', x: 100, y: 100 + i * 70, width: 480, height: 57 })), ...overrides };
}
export async function recWorld() {
  const host = createFakePluginHost({ pluginId: 'xero', agentSkillIds: ['xero'], appUrl: 'https://bb.example', settings: { clientId: 'CLIENT', clientSecret: 'SECRET_CLIENT' } });
  let mode = 'ok', onAccounts = async () => {}; const calls = [];
  await plugin(host.bb, { fetcher: async (url, init) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (mode === 'failure') throw new Error('SECRET_PROVIDER PRIVATE_CONTENT');
    if (String(url).includes('/connect/token')) return Response.json({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 1800, scope: SCOPES.join(' ') });
    if (String(url).endsWith('/connections')) return Response.json([{ tenantId: TENANT, tenantName: 'Example organisation', tenantType: 'ORGANISATION' }]);
    if (String(url).includes('/Accounts')) { await onAccounts(); return Response.json({ Accounts: [mode === 'base' ? { ...account, CurrencyCode: undefined } : account] }); }
    return Response.json({ Organisations: [{ BaseCurrency: 'CAD' }] });
  } });
  const rpc = (name, input = null) => host.harness.behavior.callRpc(name, input);
  const { url } = await rpc('beginConnect'); await host.harness.behavior.fetchHttp('GET', '/callback?state=' + new URL(url).searchParams.get('state') + '&code=SECRET_CODE');
  calls.length = 0;
  return { host, calls, rpc, beforeAccounts(fn) { onAccounts = fn; }, mode(value) { mode = value; }, close: () => host.harness.lifecycle.dispose() };
}
