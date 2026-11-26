import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const maxPageBytes = 256 * 1024;

export class WebFailure extends Error {
  constructor(readonly reason: 'address_blocked' | 'transport' | 'response_limit', readonly sent: boolean) {
    super(reason);
  }
}

export function httpsTarget(value: string, base?: URL) {
  if (!value || value.length > 8192 || /[\u0000-\u0020\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) ? !isPublicAddress(hostname) :
      !hostname.includes('.') || hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(hostname)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const ipv4 = ipaddr.IPv4.parse(address);
    return ipv4.range() === 'unicast' && !['192.0.0.', '192.88.99.', '192.0.170.'].some(prefix => address.startsWith(prefix));
  }
  if (family !== 6 || address.includes('%')) return false;
  const ipv6 = ipaddr.IPv6.parse(address);
  return ipv6.range() === 'unicast' && (ipv6.parts[0]! & 0xe000) === 0x2000;
}

export type WebResponse = { status: number; html: string; location?: string };
export type WebRequest = (url: URL, signal: AbortSignal, body?: URLSearchParams) => Promise<WebResponse>;

export const webRequest: WebRequest = async (url, signal, body) => {
  const target = httpsTarget(url.href);
  if (!target) throw new WebFailure('address_blocked', false);
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const pin = await resolvePublic(target.hostname.replace(/^\[|\]$/g, ''), signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const encoded = body?.toString();
    const req = request(target, {
      method: body ? 'POST' : 'GET', signal, agent: false, family: pin.family,
      lookup: (_host, _options, done) => done(null, pin.address, pin.family),
      headers: {
        Accept: 'text/html, application/xhtml+xml, text/plain', 'Accept-Encoding': 'identity',
        ...(encoded === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(encoded) }),
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const type = response.headers['content-type'] ?? '';
      const readBody = status >= 200 && status < 300 && /^(text\/(html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(type);
      if (!readBody) {
        response.destroy();
        resolve({ status, html: '', location });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('error', () => reject(new WebFailure('transport', true)));
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxPageBytes) {
          reject(new WebFailure('response_limit', true));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, html: Buffer.concat(chunks).toString('utf8'), location }));
    });
    req.on('error', () => reject(new WebFailure('transport', true)));
    req.end(encoded);
  });
};

async function resolvePublic(hostname: string, signal: AbortSignal) {
  let abort = () => {};
  try {
    signal.throwIfAborted();
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new WebFailure('transport', false));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new WebFailure('address_blocked', false);
    return addresses.find(item => item.family === 4) ?? addresses[0]!;
  } catch (error) {
    if (error instanceof WebFailure) throw error;
    throw new WebFailure('transport', false);
  } finally { signal.removeEventListener('abort', abort); }
}
