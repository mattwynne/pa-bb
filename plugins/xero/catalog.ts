import data from './upstream/api-catalog.json' with { type: 'json' };
import { XeroError } from './diagnostic.ts';
export const API_NAMES = ['accounting', 'assets', 'files', 'projects', 'payroll-au', 'payroll-au-v2', 'payroll-nz', 'payroll-uk', 'bankfeeds', 'bankfeeds-v2', 'finance', 'accountdata', 'app-store', 'identity', 'einvoicing', 'practice-manager', 'platform'] as const;
export type ApiName = typeof API_NAMES[number];
export type Parameter = { name: string; in: string; required?: boolean; style?: string; explode?: boolean; schema?: Record<string, unknown>; description?: string };
export type Operation = { id: string; method: string; path: string; wirePath: string; summary: string; description?: string; parameters: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema?: Record<string, unknown> }> }; responses: Record<string, { content?: Record<string, unknown> }>;
  scopeHints: string[]; declaredScopes: string[] };
export type Family = { title: string; baseUrl: string; authentication: string; restricted: boolean; documentation?: string; scopes: Record<string, string>; operations: Operation[]; schemas: Record<string, unknown> };
export const catalog = structuredClone(data) as unknown as { source: { repository: string; revision: string; version: string; notes: string }; families: Record<ApiName, Family> };
// These documented APIs are outside the upstream OpenAPI repository. Keep a raw route rather than implying that a missing generated operation means unavailable.
for (const [api, title, baseUrl, documentation] of [
  ['einvoicing', 'eInvoicing registrations', 'https://api.xero.com/einvoicing.xro/1.0', 'https://developer.xero.com/documentation/api/einvoicing/einvoicing-registrations'],
  ['practice-manager', 'Practice Manager 3.1', 'https://api.xero.com/practicemanager/3.1', 'https://developer.xero.com/documentation/api/practice-manager-3-1/jobs'],
  ['platform', 'Other documented Xero API paths', 'https://api.xero.com', 'https://developer.xero.com/documentation/api/overview'],
]) catalog.families[api as ApiName] = { title: title!, baseUrl: baseUrl!, documentation, authentication: 'authorization_code', restricted: true, scopes: {}, operations: [], schemas: {} };
export function operation(api: ApiName, id: string) {
  const op = catalog.families[api]?.operations.find(op => op.id === id);
  if (!op) throw new XeroError('input', 'api_discovery', 'Unknown Xero operation. Discover its API family and exact operation ID first.');
  return op;
}
export function listOperations({ api, search = '', page = 1, pageSize = 20 }: { api?: ApiName; search?: string; page?: number; pageSize?: number }) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const all = API_NAMES.filter(name => !api || name === api).flatMap(name => catalog.families[name].operations.map(op => ({ api: name, id: op.id, method: op.method, path: op.path, summary: op.summary,
    scopeHints: op.scopeHints, restricted: catalog.families[name].restricted, authentication: catalog.families[name].authentication })));
  const matches = all.filter(op => words.every(word => `${op.id} ${op.path} ${op.summary}`.toLowerCase().includes(word)));
  return { sourceRevision: catalog.source.revision, total: matches.length, page, nextPage: page * pageSize < matches.length ? page + 1 : null,
    operations: matches.slice((page - 1) * pageSize, page * pageSize),
    families: API_NAMES.map(name => ({ api: name, title: catalog.families[name].title, operations: catalog.families[name].operations.length, restricted: catalog.families[name].restricted, documentation: catalog.families[name].documentation, rawRequestsAvailable: true })),
    notice: 'Catalog coverage is not proof of granted permissions, provider eligibility or live verification. Scope hints include legacy upstream declarations; consult current Xero scope documentation. Raw requests also support provider additions not yet in this snapshot.' };
}
export function describeOperation(api: ApiName, id: string) {
  const family = catalog.families[api];
  return { api, ...operation(api, id), baseUrl: family.baseUrl, authentication: family.authentication, restricted: family.restricted,
    notice: 'Use xero_request with api and operationId. Supply parameters by exact name. Tenant and authorization headers are managed by BB. Body fields retain Xero casing. Resolve #/components/schemas/Name through xero_read_schema.' };
}
export function readSchema(api: ApiName, name: string, pointer = '') {
  let value = Object.hasOwn(catalog.families[api].schemas, name) ? catalog.families[api].schemas[name] : undefined;
  if (!value) throw new XeroError('input', 'api_discovery', 'Unknown schema. Use a schema name from the operation description.');
  for (const key of pointer.split('/').slice(1).map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new XeroError('input', 'api_discovery', 'Unknown schema fragment. Use a JSON pointer within this schema.');
    value = (value as Record<string, unknown>)[key];
  }
  return { api, name, pointer, schema: value };
}
