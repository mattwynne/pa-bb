import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { CloudError } from '../core/ports.ts';

export interface PhotoRemote {
  list(path: string[], signal: AbortSignal): Promise<unknown>;
  object(path: string[], signal: AbortSignal): Promise<IncomingMessage>;
}

const name = z.string().min(1).max(1024).refine(value => value !== '.' && value !== '..' && !/[\/\\\x00-\x1f\x7f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value));
const nativeListing = z.object({ list: z.array(z.object({ Name: name, Path: z.string().max(32_768), IsDir: z.boolean(), Size: z.number().int().safe() })).max(200_000) });
type Entry = { name: string; directory: boolean; size: number | null };
type Listing = { path: string[]; entries: Entry[]; expires: number };
type Ticket = { path: string[]; expires: number; previewType: string | null };
const pageSize = 100;
export const previewLimit = 20 * 1024 * 1024;
const previewTypes: Readonly<Record<string, string>> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

export function photoLibrary(remote: PhotoRemote, connected: () => boolean) {
  let busy = false;
  const listings = new Map<string, Listing>();
  const tickets = new Map<string, Ticket>();
  let lifetime = new AbortController();

  async function run<T>(action: (signal: AbortSignal) => Promise<T>, request?: AbortSignal) {
    if (!connected()) throw new CloudError('authentication');
    if (busy) throw new CloudError('busy');
    busy = true;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(150_000), ...(request ? [request] : [])]);
    try { return await action(signal); }
    catch (error) { signal.throwIfAborted(); throw error; }
    finally { busy = false; }
  }

  async function browse(path: string[], signal: AbortSignal): Promise<Entry[]> {
    const directory = path.join('/');
    const prefix = directory ? `${directory}/` : '';
    const value = await remote.list(path, signal);
    const parsed = nativeListing.safeParse(value);
    if (!parsed.success) throw new CloudError('unavailable');
    const seen = new Set<string>();
    return parsed.data.list.map(item => {
      if (prefix + item.Name !== item.Path || seen.has(item.Name)) throw new CloudError('unavailable');
      seen.add(item.Name);
      return { name: item.Name, directory: item.IsDir, size: item.IsDir || item.Size < 0 ? null : item.Size };
    }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  function getListing(id: string) {
    const value = listings.get(id);
    if (!value || value.expires <= Date.now()) throw new CloudError('invalid_selection');
    return value;
  }

  function requireSignIn() {
    if (!connected()) throw new CloudError('authentication');
  }

  return {
    browse(parent: { listing: string; index: number | null } | null, request?: AbortSignal) {
      return run(async signal => {
        requireSignIn();
        let path: string[] = [];
        if (parent) {
          const current = getListing(parent.listing);
          if (parent.index === null) path = current.path.slice(0, -1);
          else {
            const entry = current.entries[parent.index];
            if (!entry?.directory || current.path.length >= 32) throw new CloudError('invalid_selection');
            path = [...current.path, entry.name];
          }
        }
        const entries = await browse(path, signal);
        signal.throwIfAborted();
        requireSignIn();
        const listing = randomUUID();
        listings.set(listing, { entries, path, expires: Date.now() + 10 * 60_000 });
        if (listings.size > 3) listings.delete(listings.keys().next().value!);
        return { listing, total: entries.length, entries: entries.slice(0, pageSize) };
      }, request);
    },
    async page(id: string, offset: number) {
      requireSignIn();
      return { entries: getListing(id).entries.slice(offset, offset + pageSize) };
    },
    async ticket(id: string, index: number, mode: 'download' | 'preview') {
      requireSignIn();
      const current = getListing(id);
      const entry = current.entries[index];
      if (!entry || entry.directory) throw new CloudError('invalid_selection');
      const extension = /\.([a-z]+)$/i.exec(entry.name)?.[1].toLowerCase() ?? '';
      const previewType = mode === 'preview' && Object.hasOwn(previewTypes, extension) ? previewTypes[extension] : null;
      if (mode === 'preview' && (!previewType || entry.size === null || entry.size > previewLimit)) throw new CloudError('invalid_selection');
      const ticket = randomUUID();
      tickets.set(ticket, { path: [...current.path, entry.name], expires: Date.now() + 60_000, previewType });
      if (tickets.size > 64) tickets.delete(tickets.keys().next().value!);
      return { ticket };
    },
    async download(id: string, signal: AbortSignal) {
      const ticket = tickets.get(id);
      tickets.delete(id);
      if (!ticket || ticket.expires <= Date.now()) throw new CloudError('invalid_selection');
      if (busy) throw new CloudError('busy');
      busy = true;
      let response: IncomingMessage | undefined;
      try {
        requireSignIn();
        const operation = AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(60 * 60_000)]);
        response = await remote.object(ticket.path, operation);
        if (response.statusCode !== 200) throw new CloudError('unavailable');
        response.once('close', () => { busy = false; });
        return { response, filename: ticket.path.at(-1)!, previewType: ticket.previewType };
      } catch (error) {
        response?.destroy();
        busy = false;
        throw error;
      }
    },
    invalidate() {
      lifetime.abort();
      lifetime = new AbortController();
      listings.clear();
      tickets.clear();
    },
  };
}
