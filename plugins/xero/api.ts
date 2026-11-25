import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { API_NAMES, catalog, operation, type ApiName, type Operation, type Parameter } from './catalog.ts';
import { providerFetch, type Connection } from './connection.ts';
import { readUpload, responseBytes, fileName, MAX_TRANSFER_BYTES } from './file-transfer.ts';
import { XeroError } from './diagnostic.ts';
const scalar = z.union([z.string().max(8000), z.number().finite(), z.boolean()]);
const values = z.record(z.string().min(1).max(100), z.union([scalar, z.array(scalar).max(1000)]));
const mime = z.string().max(150).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/);
export const requestSchema = z.object({
  api: z.enum(API_NAMES).default('accounting'), tenantId: z.uuid().optional(),
  operationId: z.string().min(1).max(200).optional(), path: z.string().min(1).max(3000).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  parameters: values.optional(), pathParameters: z.record(z.string(), scalar).optional(), query: values.optional(), headers: z.record(z.string(), z.string().max(1000)).optional(),
  arrayFormat: z.enum(['comma', 'repeat']).optional(), body: z.unknown().optional(), textBody: z.string().max(MAX_TRANSFER_BYTES).optional(),
  upload: z.object({ filePath: z.string().min(1).max(4096), fileName: z.string().max(240).optional(), contentType: mime.default('application/octet-stream') }).strict().optional(),
  contentType: mime.optional(), accept: mime.optional(), downloadName: z.string().max(240).optional(), idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.operationId) === Boolean(value.path)) ctx.addIssue({ code: 'custom', message: 'Provide exactly one of operationId or path.' });
  if ([value.upload !== undefined, value.body !== undefined, value.textBody !== undefined].filter(Boolean).length > 1) ctx.addIssue({ code: 'custom', message: 'Provide only one of upload, JSON body or textBody.' });
});
export type ApiRequest = z.infer<typeof requestSchema>;
export type Receipt = { httpStatus: number | null; observedIds: string[]; idempotencyKey?: string; partialPossible: boolean };
export class ApiRequestError extends XeroError {
  readonly receipt: Receipt;
  constructor(error: unknown, receipt: Receipt) {
    const safe = error instanceof XeroError ? error : new XeroError('unknown', 'api_write', 'The Xero write outcome is uncertain. Inspect the record before retrying; no automatic retry was made.');
    super(safe.category, safe.stage, safe.message, true, safe.status); this.receipt = receipt;
  }
}
export class ApiResultError extends ApiRequestError {
  constructor(receipt: Receipt) {
    super(new XeroError('provider_result', 'api_result', 'Xero returned error or partial-failure results. Some writes may have been applied. Inspect the affected records before retrying; observed IDs do not establish success.'), receipt);
  }
}
function invalid(message: string): never { throw new XeroError('input', 'api_validation', message); }
function safePath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\?#\x00-\x20\x7f]/.test(path)) invalid('Use a relative Xero API path; put query parameters in query. URLs, backslashes and control characters are not accepted.');
  for (const segment of path.split('/')) {
    let decoded = segment;
    for (let i = 0; i < 5; i++) {
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
      catch { invalid('Use valid percent-encoding in the Xero path.'); }
    }
    if (decoded === '.' || decoded === '..' || /[\\/\x00-\x1f\x7f]/.test(decoded) || /%[a-f\d]{2}/i.test(decoded)) invalid('Path traversal and encoded path separators are not accepted.');
  }
  return path;
}
function fillPath(template: string, parameters: Record<string, unknown>) {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = Object.hasOwn(parameters, name) ? parameters[name] : undefined;
    if (value === undefined || Array.isArray(value)) invalid('Supply every required path parameter using its exact name.');
    return encodeURIComponent(String(value));
  });
}
function header(name: string, value: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(name) || /authorization|cookie|secret|password|token|api-?key|^host$|^content-|^accept$|^xero-tenant-id$|^idempotency-key$|forwarded|^origin$|^referer$|^connection$|^upgrade$|^transfer-encoding$|^te$|^trailer$|^proxy-/i.test(name) || /[\x00-\x1f\x7f]/.test(value)) invalid('Only non-secret provider headers can be supplied. BB owns authorization, tenant, content and idempotency headers; never supply credentials through tool arguments.');
  return value;
}
function addQuery(url: URL, name: string, value: unknown, parameter?: Parameter, arrayFormat = 'comma') {
  if (Array.isArray(value)) {
    const repeat = parameter ? parameter.explode ?? true : arrayFormat === 'repeat';
    if (repeat) value.forEach(item => url.searchParams.append(name, String(item)));
    else url.searchParams.set(name, value.map(String).join(','));
  } else url.searchParams.set(name, String(value));
}
function rejected(value: unknown, depth = 0): boolean {
  if (depth > 40 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => rejected(item, depth + 1));
  const item = value as Record<string, unknown>;
  return item.HasErrors === true || item.HasValidationErrors === true || (typeof item.ErrorNumber === 'number' && item.ErrorNumber > 0) ||
    [item.Status, item.status].some(s => typeof s === 'string' && /^(ERROR|FAILED|FAILURE|PARTIAL_FAILURE)$/i.test(s)) ||
    ['ValidationErrors', 'validationErrors', 'Errors', 'errors'].some(key => Array.isArray(item[key]) && item[key].length > 0) ||
    Object.values(item).some(child => rejected(child, depth + 1));
}
function observedIds(value: unknown) {
  const ids = new Set<string>();
  function visit(value: unknown, depth: number) {
    if (depth > 40 || ids.size >= 100 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || /id$/i.test(key)) && typeof child === 'string' && z.uuid().safeParse(child).success) ids.add(child);
      else visit(child, depth + 1);
    }
  }
  visit(value, 0); return [...ids];
}
export function createApi({ connection, fetcher = fetch, signal, save }: { connection: Connection; fetcher?: typeof fetch; signal: AbortSignal;
  save?: (bytes: Buffer, mimeType: string, name: string, signal: AbortSignal) => Promise<unknown> }) {
  return {
    async request(input: ApiRequest, callerSignal?: AbortSignal) {
      const family = catalog.families[input.api], op: Operation | undefined = input.operationId ? operation(input.api, input.operationId) : undefined;
      const method = op?.method ?? input.method ?? 'GET';
      if (op && input.method && input.method !== op.method) invalid('The method must match the discovered operation.');
      if (op && (input.query || input.pathParameters || input.headers)) invalid('For a discovered operation, supply its named path, query and conditional headers through parameters.');
      if (!op && input.parameters && Object.keys(input.parameters).length) invalid('Raw paths use query, pathParameters and headers. Use parameters with an operationId.');
      const parameters = input.parameters ?? {}, query: Record<string, unknown> = { ...input.query }, suppliedHeaders: Record<string, string> = {};
      if (op) {
        for (const name of Object.keys(parameters)) if (!op.parameters.some(p => p.name === name)) invalid('An input parameter is not declared by this operation. Describe it and use exact parameter names, or use an explicit raw path for a provider addition.');
        for (const p of op.parameters) {
          if (['xero-tenant-id', 'idempotency-key', 'contenttype'].includes(p.name.toLowerCase())) {
            if (parameters[p.name] !== undefined) invalid('Use tenantId, idempotencyKey or contentType rather than overriding BB-managed headers.');
            continue;
          }
          const value = parameters[p.name];
          if (p.required && value === undefined) invalid('Supply every required parameter from the operation description.');
          if (value === undefined) continue;
          if (p.in === 'query') query[p.name] = value;
          else if (p.in === 'header') suppliedHeaders[p.name] = header(p.name, String(value));
        }
      }
      for (const [name, value] of Object.entries(input.headers ?? {})) suppliedHeaders[name] = header(name, value);
      const path = safePath(fillPath(op?.wirePath ?? input.path!, op ? parameters : input.pathParameters ?? {}));
      const url = new URL(family.baseUrl + path);
      if (url.origin !== 'https://api.xero.com' || !url.pathname.startsWith(new URL(family.baseUrl).pathname + (family.baseUrl.endsWith('.com') ? '' : '/'))) invalid('The path must stay within the selected Xero API family.');
      // Identity only manages connections; token endpoints and secrets are never available through tools.
      if (input.api === 'identity' && !/^\/Connections(?:\/[a-f\d-]{36})?$/i.test(path)) invalid('Identity requests support only Xero connection management. Token operations remain private to BB.');
      for (const [name, value] of Object.entries(query)) addQuery(url, name, value, op?.parameters.find(p => p.in === 'query' && p.name === name), input.arrayFormat);
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method), key = mutation ? input.idempotencyKey ?? randomUUID() : undefined;
      if (!mutation && (input.body !== undefined || input.textBody !== undefined || input.upload)) invalid('Read requests cannot carry a write body or upload.');
      const stage = mutation ? 'api_write' : 'api_read';
      if (!['identity', 'platform'].includes(input.api) && family.authentication !== 'client_credentials' && !input.tenantId) invalid('Select an explicit connected tenantId for this Xero API family.');
      if (input.downloadName) fileName(input.downloadName);
      const auth = family.authentication === 'client_credentials' ? await connection.application() : await connection.authorize(input.tenantId);
      const accept = input.accept ?? Object.values(op?.responses ?? {}).flatMap(r => Object.keys(r.content ?? {}))[0] ?? (input.api === 'practice-manager' ? 'application/xml' : 'application/json');
      const headers: Record<string, string> = { ...suppliedHeaders, Authorization: `Bearer ${auth.token}`, Accept: accept,
        ...(input.tenantId && input.api !== 'identity' && family.authentication !== 'client_credentials' ? { 'xero-tenant-id': input.tenantId } : {}), ...(key ? { 'Idempotency-Key': key } : {}) };
      let body: BodyInit | undefined;
      const bodyType = input.contentType ?? (input.upload ? Object.keys(op?.requestBody?.content ?? {})[0] ?? 'application/octet-stream' : input.textBody !== undefined ? 'application/xml' : 'application/json');
      if (op?.requestBody?.required && input.body === undefined && input.textBody === undefined && !input.upload) invalid('This operation requires a request body or upload; describe its schema first.');
      if (input.upload) {
        const upload = await readUpload(input.upload.filePath), name = fileName(input.upload.fileName ?? upload.name);
        if (bodyType === 'multipart/form-data') {
          const form = new FormData(); form.set('body', new Blob([new Uint8Array(upload.bytes)], { type: input.upload.contentType }), name);
          form.set('name', name); form.set('filename', name); form.set('mimeType', input.upload.contentType); body = form;
        } else { body = upload.bytes as unknown as BodyInit; headers['Content-Type'] = input.contentType ?? input.upload.contentType; }
      } else if (input.textBody !== undefined) {
        if (Buffer.byteLength(input.textBody) > MAX_TRANSFER_BYTES) invalid('Request body exceeds 20 MiB. Use smaller batches.');
        body = input.textBody; headers['Content-Type'] = bodyType;
      } else if (input.body !== undefined) {
        const encoded = JSON.stringify(input.body); if (Buffer.byteLength(encoded) > MAX_TRANSFER_BYTES) invalid('Request body exceeds 20 MiB. Use smaller batches.');
        body = encoded; headers['Content-Type'] = bodyType;
      }
      auth.ensure();
      const combined = AbortSignal.any([signal, callerSignal ?? signal]); combined.throwIfAborted();
      let httpStatus: number | null = null;
      try {
      const response = await providerFetch(fetcher, url, { method, headers, body, signal: combined }, stage, mutation, mutation ? [] : [304]);
      httpStatus = response.status;
      const bytes = await responseBytes(response, stage); auth.ensure(); combined.throwIfAborted();
      const responseHeaders = Object.fromEntries(['etag', 'last-modified', 'retry-after'].flatMap(name => { const value = response.headers.get(name); return value && value.length <= 2000 ? [[name, value]] : []; }));
      const receipt = { api: input.api, operationId: op?.id ?? null, httpStatus: response.status, responseHeaders, ...(key ? { idempotencyKey: key, idempotencyDeclared: op?.parameters.some(p => p.name.toLowerCase() === 'idempotency-key') ?? false } : {}), verification: mutation ? 'provider_response_only' : 'single_response_not_complete_inventory' };
      if (response.status === 204 || response.status === 304 || method === 'HEAD' || !bytes.length) return { ...receipt, data: null };
      const returnedType = response.headers.get('content-type')?.split(';')[0]?.trim(), contentType = returnedType && mime.safeParse(returnedType).success ? returnedType : accept;
      const json = /(?:^application\/json$|\+json$)/i.test(contentType);
      let data: unknown;
      if (json) {
        try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new XeroError('response_invalid', stage, 'Xero returned unreadable JSON. Any requested change may already be saved; inspect it before retrying.'); }
        if (rejected(data)) throw new ApiResultError({ httpStatus: response.status, observedIds: observedIds(data), idempotencyKey: key, partialPossible: mutation });
      }
      const textual = /^text\//i.test(contentType) || /xml/i.test(contentType);
      if (textual) {
        const encoding = /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
        try { data = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
        catch { if (!input.downloadName) throw new XeroError('response_invalid', stage, 'Xero returned text that could not be decoded. Use downloadName to preserve its original bytes. Inspect any requested change before retrying.'); }
      }
      if (/xml/i.test(contentType) && typeof data === 'string' && /<Status>\s*(?:ERROR|FAILED|FAILURE)\s*<\/Status>/i.test(data)) throw new ApiResultError({ httpStatus: response.status, observedIds: [], idempotencyKey: key, partialPossible: mutation });
      if (input.downloadName || (!json && !textual)) {
        if (!save) throw new XeroError('configuration', 'download_save', 'This response needs current-thread file storage. Run the request in a BB thread; any provider write may already be saved.');
        const name = input.downloadName ?? (contentType === 'application/pdf' ? 'xero-document.pdf' : /xml/i.test(contentType) ? 'xero-response.xml' : 'xero-download.bin');
        return { ...receipt, ...(textual && data === undefined ? { warning: 'Text encoding could not be verified. Inspect the original downloaded bytes; no business outcome is confirmed.' } : {}), download: await save(bytes, contentType, fileName(name), combined) };
      }
      return { ...receipt, contentType, data };
      } catch (error) {
        if (error instanceof ApiRequestError || !mutation) throw error;
        throw new ApiRequestError(error, { httpStatus: httpStatus ?? (error instanceof XeroError ? error.status ?? null : null), observedIds: [], idempotencyKey: key, partialPossible: true });
      }
    },
  };
}
