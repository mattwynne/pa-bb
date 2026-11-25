// Generate a portable, reviewable catalog from a locally checked-out official Xero OpenAPI revision.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// PyYAML accepts upstream's unindented closing quotes in Bank Feeds v2; JS YAML parsers reject that file.
const parse = source => JSON.parse(execFileSync(process.env.PYTHON ?? 'python3', ['-c', 'import sys,json,yaml; json.dump(yaml.safe_load(sys.stdin),sys.stdout,default=str)'], { input: source, encoding: 'utf8', maxBuffer: 16_000_000 }));
const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: npm run catalog:update -- /path/to/Xero-OpenAPI');
const files = {
  accounting: 'xero_accounting.yaml', assets: 'xero_assets.yaml', files: 'xero_files.yaml', projects: 'xero-projects.yaml',
  'payroll-au': 'xero-payroll-au.yaml', 'payroll-au-v2': 'xero-payroll-au-v2.yaml', 'payroll-nz': 'xero-payroll-nz.yaml', 'payroll-uk': 'xero-payroll-uk.yaml',
  bankfeeds: 'xero_bankfeeds.yaml', 'bankfeeds-v2': 'xero_bankfeeds_v2.yaml', finance: 'xero-finance.yaml', accountdata: 'xero-accountdata.yaml',
  'app-store': 'xero-app-store.yaml', identity: 'xero-identity.yaml',
};
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const revision = execFileSync('git', ['-C', resolve(checkout), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a Git commit');
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('x-') && !['example', 'examples', 'externalDocs'].includes(key)).map(([k, v]) => [k, clean(v)]));
  return value;
}
function hints(api, path, method, scopes) {
  if (api !== 'accounting') return scopes;
  const resource = path.split('/')[1], read = ['get', 'head', 'options'].includes(method);
  const scope = ['BankTransactions', 'BankTransfers'].includes(resource) ? 'accounting.banktransactions'
    : ['Payments', 'Prepayments', 'Overpayments', 'BatchPayments'].includes(resource) ? 'accounting.payments'
    : resource === 'ManualJournals' ? 'accounting.manualjournals'
    : ['Invoices', 'CreditNotes', 'Quotes', 'PurchaseOrders', 'RepeatingInvoices'].includes(resource) ? 'accounting.invoices' : null;
  if (scopes.some(s => s.startsWith('accounting.transactions')) && scope) return [...(read ? [scope + '.read'] : []), scope, ...scopes];
  const report = path.split('/')[2];
  const reportScopes = { AgedPayablesByContact: 'aged', AgedReceivablesByContact: 'aged', BalanceSheet: 'balancesheet', BankSummary: 'banksummary', BudgetSummary: 'budgetsummary', ExecutiveSummary: 'executivesummary', ProfitAndLoss: 'profitandloss', TrialBalance: 'trialbalance', TenNinetyNine: 'tenninetynine' };
  if (scopes.includes('accounting.reports.read') && reportScopes[report]) return ['accounting.reports.' + reportScopes[report] + '.read', ...scopes];
  return scopes;
}
const families = {}, versions = new Set();
for (const [api, file] of Object.entries(files)) {
  const source = await readFile(resolve(checkout, file), 'utf8'), spec = parse(source);
  versions.add(spec.info.version);
  function deref(value) {
    if (!value?.$ref) return value;
    if (!value.$ref.startsWith('#/')) throw new Error('External reference is not supported');
    return value.$ref.slice(2).split('/').reduce((v, key) => v[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
  }
  const baseUrl = spec.servers[0].url.replace(/\/$/, '');
  if (new URL(baseUrl).origin !== 'https://api.xero.com') throw new Error('Unrecognized upstream server');
  const scheme = spec.components.securitySchemes.OAuth2.flows, operations = [];
  for (const [path, item] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    if (!op.operationId) throw new Error('Missing operation ID');
    const params = new Map([...item.parameters ?? [], ...op.parameters ?? []].map(p => deref(p)).map(p => [p.in + ':' + p.name, clean(p)]));
    const responses = Object.fromEntries(Object.entries(op.responses).filter(([code]) => /^2\d\d$/.test(code)).map(([code, response]) => [code, clean(deref(response))]));
    const declaredScopes = [...new Set((op.security ?? spec.security ?? []).flatMap(s => s.OAuth2 ?? []))];
    operations.push({ id: op.operationId, method: method.toUpperCase(), path, wirePath: op['x-path'] ?? path,
      summary: op.summary ?? op.description ?? op.operationId, ...(op.description ? { description: op.description } : {}),
      parameters: [...params.values()], ...(op.requestBody ? { requestBody: clean(deref(op.requestBody)) } : {}), responses,
      scopeHints: hints(api, path, method, declaredScopes), declaredScopes,
    });
  }
  if (new Set(operations.map(o => o.id)).size !== operations.length) throw new Error('Duplicate operation ID');
  families[api] = { title: spec.info.title, baseUrl, authentication: scheme.clientCredentials ? 'client_credentials' : 'authorization_code',
    restricted: ['bankfeeds', 'bankfeeds-v2', 'finance', 'accountdata', 'app-store'].includes(api),
    source: { file, sha256: createHash('sha256').update(source).digest('hex') },
    scopes: Object.assign({}, ...Object.values(scheme).map(flow => flow.scopes)), operations, schemas: clean(spec.components.schemas ?? {}) };
}
const output = { source: { repository: 'https://github.com/XeroAPI/Xero-OpenAPI', revision, version: [...versions].join(', '),
  scopeDocumentation: 'https://developer.xero.com/documentation/guides/oauth2/scopes/',
  notes: 'Scope hints combine upstream declarations and documented granular equivalents. They are guidance, not proof of grant or provider eligibility. Webhooks describes inbound events, not callable operations.' }, families };
await mkdir(new URL('../upstream/', import.meta.url), { recursive: true });
await writeFile(new URL('../upstream/api-catalog.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
await writeFile(new URL('../upstream/LICENSE.Xero-OpenAPI', import.meta.url), await readFile(resolve(checkout, 'LICENSE')));
console.log(Object.fromEntries(Object.entries(families).map(([name, f]) => [name, f.operations.length])));
