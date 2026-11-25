import { createConnection, SCOPES, type Store, type Session, type Pending, type Client } from '../connection.ts';
export const TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const INVOICE = '33333333-3333-4333-8333-333333333333';
export const ACCOUNT = '44444444-4444-4444-8444-444444444444';
export const KEY = '55555555-5555-4555-8555-555555555555';
export const tenant = { tenantId: TENANT, tenantName: 'Example organisation', tenantType: 'ORGANISATION' };
export const tokens = { access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 1800, scope: SCOPES.join(' ') };
export const invoice = () => ({ InvoiceID: INVOICE, Type: 'ACCPAY', Status: 'AUTHORISED', CurrencyCode: 'USD', CurrencyRate: 0.72,
  Date: '2026-01-01', DueDate: '2026-01-31', Total: 100, AmountDue: 100, AmountPaid: 0, Payments: [] as Record<string, unknown>[], Reference: 'old', LineItems: [{ Description: 'Original evidence' }] });
export function memoryStore() {
  let saved: Session | null = null; const pending = new Map<string, Pending>();
  const store: Store = { get: () => saved, save: value => { saved = value; }, clear: () => { saved = null; },
    pending: value => { pending.set(value.hash, value); }, consume: hash => { const value = pending.get(hash); pending.delete(hash); return value ?? null; }, clearPending: () => pending.clear() };
  return store;
}
export function world() {
  let now = 1_000_000;
  const client: Client = { clientId: 'CLIENT', clientSecret: 'SECRET_CLIENT' }, store = memoryStore(), controller = new AbortController();
  const calls: { url: URL; init: RequestInit }[] = [];
  let handler: (url: URL, init: RequestInit) => Response | Promise<Response> = url => url.hostname === 'identity.xero.com' ? Response.json(tokens) : Response.json([tenant]);
  const fetcher = (async (url, init = {}) => { const u = new URL(String(url)); calls.push({ url: u, init }); return handler(u, init); }) as typeof fetch;
  const connection = createConnection({ store, getClient: async () => client, callbackUrl: () => 'https://bb.example/api/v1/plugins/xero/http/callback', signal: controller.signal, fetcher, clock: () => now });
  return { connection, store, client, calls, fetcher, controller, setHandler(value: typeof handler) { handler = value; }, advance(ms: number) { now += ms; },
    seed() { store.save({ clientId: 'CLIENT', accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: now + 1800_000, scopes: [...SCOPES], tenants: [tenant] }); },
    async connect() { const { url } = await connection.begin(); await connection.finish({ state: new URL(url).searchParams.get('state')!, code: 'SECRET_CODE' }); },
  };
}
