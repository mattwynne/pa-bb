import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { PhotosError } from './errors.ts';
import type { AppleRemote } from './rclone.ts';

const name = z.string().min(1).max(1024).refine(value => value !== '.' && value !== '..' && !/[\/\\\x00-\x1f\x7f]/.test(value) && value.isWellFormed());
const nativeListing = z.object({ list: z.array(z.object({ Name: name, Path: z.string().max(32_768), IsDir: z.boolean(), Size: z.number().int().safe() })).max(200_000) });
const authReply = z.object({ State: z.string().max(16_384), Error: z.string().optional(), Option: z.object({ Name: z.string() }).nullish() });
type Entry = { name: string; directory: boolean; size: number | null };
type Listing = { path: string[]; entries: Entry[]; expires: number };
type Ticket = { path: string[]; expires: number; previewType: string | null };
const pageSize = 100;
export const previewLimit = 20 * 1024 * 1024;
const previewTypes: Readonly<Record<string, string>> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

export function applePhotos(remote: AppleRemote, signIn: { get(): Promise<boolean>; set(value: boolean): Promise<void> }) {
  let pending: { state: string; expires: number } | undefined;
  let busy = false;
  const listings = new Map<string, Listing>();
  const tickets = new Map<string, Ticket>();
  const lifetime = new AbortController();

  async function run<T>(action: (signal: AbortSignal) => Promise<T>, timeout = 150_000) {
    lifetime.signal.throwIfAborted();
    if (busy) throw new PhotosError('busy');
    busy = true;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]);
    try { return await action(signal); }
    catch (error) { signal.throwIfAborted(); throw error; }
    finally { busy = false; }
  }

  async function browse(path: string[], signal: AbortSignal): Promise<Entry[]> {
    const directory = path.join('/');
    const prefix = directory ? `${directory}/` : '';
    const value = await remote.rpc('operations/list', { fs: 'apple-photos:', remote: directory, opt: { recurse: false, noModTime: true, noMimeType: true } }, signal);
    const parsed = nativeListing.safeParse(value);
    if (!parsed.success) throw new PhotosError('unavailable');
    const seen = new Set<string>();
    return parsed.data.list.map(item => {
      if (prefix + item.Name !== item.Path || seen.has(item.Name)) throw new PhotosError('unavailable');
      seen.add(item.Name);
      return { name: item.Name, directory: item.IsDir, size: item.IsDir || item.Size < 0 ? null : item.Size };
    }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async function finish(value: unknown, signal: AbortSignal) {
    const parsed = authReply.safeParse(value);
    if (!parsed.success || parsed.data.Error) throw new PhotosError('sign_in');
    if (parsed.data.State && ['config_2fa', 'config_2fa_sms'].includes(parsed.data.Option?.Name ?? '')) {
      pending = { state: parsed.data.State, expires: Date.now() + 10 * 60_000 };
      return;
    }
    if (parsed.data.State !== '') throw new PhotosError('sign_in');
    await browse([], signal);
    await signIn.set(true);
  }

  function getListing(id: string) {
    const value = listings.get(id);
    if (!value || value.expires <= Date.now()) throw new PhotosError('selection');
    return value;
  }

  async function requireSignIn() {
    if (!await signIn.get()) throw new PhotosError('unconfigured');
  }

  function clear() {
    pending = undefined;
    listings.clear();
    tickets.clear();
  }

  return {
    async status() {
      if (pending && pending.expires > Date.now()) return 'verification' as const;
      return await signIn.get() ? 'saved' as const : 'disconnected' as const;
    },
    connect(account: string, password: string) {
      return run(async signal => {
        await signIn.set(false);
        clear();
        await remote.resetAccount(signal);
        await finish(await remote.rpc('config/create', { name: 'apple-photos', type: 'iclouddrive',
          parameters: { service: 'photos', apple_id: account, password }, opt: { nonInteractive: true, obscure: true } }, signal), signal);
      });
    },
    verify(answer: string) {
      return run(async signal => {
        const challenge = pending;
        pending = undefined;
        if (!challenge || challenge.expires <= Date.now()) throw new PhotosError('verification');
        await finish(await remote.rpc('config/update', { name: 'apple-photos', parameters: {},
          opt: { nonInteractive: true, continue: true, state: challenge.state, result: answer } }, signal), signal);
      });
    },
    disconnect() {
      return run(async signal => {
        clear();
        await signIn.set(false);
        await remote.resetAccount(signal);
      });
    },
    browse(parent: { listing: string; index: number | null } | null) {
      return run(async signal => {
        await requireSignIn();
        let path: string[] = [];
        if (parent) {
          const current = getListing(parent.listing);
          if (parent.index === null) path = current.path.slice(0, -1);
          else {
            const entry = current.entries[parent.index];
            if (!entry?.directory || current.path.length >= 32) throw new PhotosError('selection');
            path = [...current.path, entry.name];
          }
        }
        const entries = await browse(path, signal);
        const listing = randomUUID();
        listings.set(listing, { entries, path, expires: Date.now() + 10 * 60_000 });
        if (listings.size > 3) listings.delete(listings.keys().next().value!);
        return { listing, total: entries.length, entries: entries.slice(0, pageSize) };
      });
    },
    async page(id: string, offset: number) {
      await requireSignIn();
      return { entries: getListing(id).entries.slice(offset, offset + pageSize) };
    },
    async ticket(id: string, index: number, mode: 'download' | 'preview') {
      await requireSignIn();
      const current = getListing(id);
      const entry = current.entries[index];
      if (!entry || entry.directory) throw new PhotosError('selection');
      const extension = /\.([a-z]+)$/i.exec(entry.name)?.[1].toLowerCase() ?? '';
      const previewType = mode === 'preview' && Object.hasOwn(previewTypes, extension) ? previewTypes[extension] : null;
      if (mode === 'preview' && (!previewType || entry.size === null || entry.size > previewLimit)) throw new PhotosError('selection');
      const ticket = randomUUID();
      tickets.set(ticket, { path: [...current.path, entry.name], expires: Date.now() + 60_000, previewType });
      if (tickets.size > 64) tickets.delete(tickets.keys().next().value!);
      return { ticket };
    },
    async download(id: string, signal: AbortSignal) {
      const ticket = tickets.get(id);
      tickets.delete(id);
      if (!ticket || ticket.expires <= Date.now()) throw new PhotosError('selection');
      if (busy) throw new PhotosError('busy');
      busy = true;
      let response: IncomingMessage | undefined;
      try {
        await requireSignIn();
        const operation = AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(60 * 60_000)]);
        response = await remote.object(ticket.path, operation);
        if (response.statusCode !== 200) throw new PhotosError('unavailable');
        response.once('close', () => { busy = false; });
        return { response, filename: ticket.path.at(-1)!, previewType: ticket.previewType };
      } catch (error) {
        response?.destroy();
        busy = false;
        throw error;
      }
    },
    async close() {
      lifetime.abort();
      clear();
      await remote.close();
    },
  };
}
