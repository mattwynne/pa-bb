import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { identity, LocalNotes } from './local-notes.ts';
import type { SearchPath, SearchReader } from './local-notes.ts';
import { VaultError } from '../core/ports.ts';
import type { SearchRequest, SearchBatch, SearchCapability } from '../core/ports.ts';
type Candidate = SearchBatch['candidates'][number];
type Session = {
  root: string;
  rootIdentity: Awaited<ReturnType<LocalNotes['rootIdentity']>>;
  signature: string;
  revision: number;
  paths: AsyncGenerator<SearchPath>;
  seen: Set<string>;
  memory: number;
  at: number;
  created: number;
  abort: AbortController;
  task?: Promise<SearchBatch>;
  warnings: Set<SearchBatch['warnings'][number]>;
};
const inFolder = (path: string, folder: string) => path.startsWith(folder + '/');
const selected = (path: string, request: SearchRequest) =>
  (!request.folders || request.folders.some((folder) => inFolder(path, folder))) &&
  !request.excludeFolders?.some((folder) => inFolder(path, folder));
const signature = (q: SearchRequest) =>
  JSON.stringify({
    mirrorId: q.mirrorId,
    revision: q.revision,
    text: q.text,
    projection: q.projection,
    folders: q.folders ? [...q.folders].sort() : undefined,
    excludeFolders: q.excludeFolders ? [...q.excludeFolders].sort() : undefined,
  });
const env = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
class MissingExecutable extends VaultError {
  constructor() {
    super('unavailable');
  }
}
// No shell, arbitrary flags, inherited credentials, ripgrep config or raw errors.
async function command(
  binary: string,
  args: string[],
  readers: SearchReader[],
  signal: AbortSignal,
  line: (value: string) => void,
  maxLine = 8 * 1024 * 1024
) {
  if (signal.aborted) throw new VaultError('cancelled');
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe', ...readers.map((r) => r.file.fd)],
      env: env(),
    });
    let buffer = '',
      failed = false,
      missing = false,
      stderrBytes = 0,
      stdoutBytes = 0;
    const terminate = () => {
      child.kill('SIGTERM');
      const hard = setTimeout(() => child.kill('SIGKILL'), 200);
      hard.unref();
      child.once('close', () => clearTimeout(hard));
    };
    const fail = () => {
      failed = true;
      terminate();
    };
    const timeout = setTimeout(fail, 10000);
    timeout.unref();
    signal.addEventListener('abort', fail, { once: true });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (failed) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 32 * 1024 * 1024) {
        fail();
        return;
      }
      buffer += chunk;
      try {
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          if (end > maxLine) throw new Error();
          line(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
        if (Buffer.byteLength(buffer) > maxLine) throw new Error();
      } catch {
        fail();
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 8192) fail();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failed = true;
      missing = error.code === 'ENOENT';
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', fail);
      if (failed || signal.aborted || code === null || code > 1 || stderrBytes)
        reject(missing ? new MissingExecutable() : new VaultError(signal.aborted ? 'cancelled' : 'unavailable'));
      else {
        try {
          if (buffer) line(buffer);
          resolve(code);
        } catch {
          reject(new VaultError('unavailable'));
        }
      }
    });
  });
}
export class LocalSearch {
  private sessions = new Map<string, Session>();
  private closed = false;
  private running = 0;
  private probes = new Map<AbortController, Promise<number>>();
  private checking?: Promise<SearchCapability>;
  private lastCapability?: SearchCapability;
  private checkedAt = 0;
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    private store: LocalNotes,
    private binary = 'rg'
  ) {
    this.sweep = setInterval(() => {
      for (const [id, s] of this.sessions)
        if (Date.now() - s.at > 300000 || Date.now() - s.created > 1800000) void this.close(s.revision, id);
    }, 30000);
    this.sweep.unref();
  }
  async capability(): Promise<SearchCapability> {
    if (this.closed) return { version: 1, available: false, reason: 'unavailable' };
    if (this.lastCapability && Date.now() - this.checkedAt < 30000) return this.lastCapability;
    if (this.running + this.probes.size >= 2)
      return this.lastCapability ?? { version: 1, available: false, reason: 'unavailable' };
    if (!this.checking)
      this.checking = this.probe()
        .then((value) => {
          this.checkedAt = Date.now();
          return (this.lastCapability = value);
        })
        .finally(() => {
          this.checking = undefined;
        });
    return this.checking;
  }
  private async probe(): Promise<SearchCapability> {
    if (this.closed) return { version: 1, available: false, reason: 'unavailable' };
    const abort = new AbortController();
    let output = '';
    const task = command(
      this.binary,
      ['--no-config', '--version'],
      [],
      abort.signal,
      (line) => {
        output += line + '\n';
        if (Buffer.byteLength(output) > 4096) throw new Error();
      },
      4096
    );
    this.probes.set(abort, task);
    try {
      await task;
      const major = Number(/^ripgrep (\d+)\./.exec(output)?.[1]);
      return { version: 1, available: major >= 14, reason: major >= 14 ? null : 'unsupported_version' };
    } catch (error) {
      return {
        version: 1,
        available: false,
        reason: error instanceof MissingExecutable ? 'missing_executable' : 'unavailable',
      };
    } finally {
      this.probes.delete(abort);
    }
  }
  private async *paths(root: string, q: SearchRequest) {
    yield* this.store.searchPaths(root, {
      file: (path) => selected(path, q),
      directory: (path) =>
        (!q.folders ||
          q.folders.some((folder) => folder === path || folder.startsWith(path + '/') || inFolder(path, folder))) &&
        !q.excludeFolders?.some((folder) => folder === path || inFolder(path, folder)),
    });
  }
  async next(request: SearchRequest, root: string, signal?: AbortSignal): Promise<SearchBatch> {
    const guard = () => {
      if (signal?.aborted) throw new VaultError('cancelled');
    };
    guard();
    if (this.closed) throw new VaultError('unavailable');
    if (this.running + this.probes.size >= 2) throw new VaultError('capacity');
    if (request.startOnly && request.cursor) throw new VaultError('invalid_query');
    let id = request.cursor,
      s = id ? this.sessions.get(id) : undefined;
    if (id && (!s || Date.now() - s.at > 300000 || Date.now() - s.created > 1800000)) {
      if (s) await this.close(request.revision, id);
      throw new VaultError('cursor_expired');
    }
    if (s && s.signature !== signature(request)) throw new VaultError('invalid_query');
    if (s?.task) throw new VaultError('busy');
    const rootIdentity = await this.store.rootIdentity(root);
    if (s && (s.root !== root || !identity(s.rootIdentity, rootIdentity))) {
      await this.close(request.revision, id!);
      throw new VaultError('cursor_expired');
    }
    if (s?.task) throw new VaultError('busy');
    if (this.running + this.probes.size >= 2) throw new VaultError('capacity');
    if (!s) {
      if (this.sessions.size >= 4) throw new VaultError('capacity');
      if (!(await this.capability()).available) throw new VaultError('unsupported');
      guard();
      if (this.running + this.probes.size >= 2 || this.sessions.size >= 4) throw new VaultError('capacity');
      id = randomUUID();
      s = {
        root,
        rootIdentity,
        signature: signature(request),
        revision: request.revision,
        paths: this.paths(root, request),
        seen: new Set(),
        memory: 0,
        at: Date.now(),
        created: Date.now(),
        abort: new AbortController(),
        warnings: new Set(),
      };
      this.sessions.set(id, s);
    }
    if (request.startOnly) return { candidates: [], nextCursor: id!, visited: 0, warnings: [] };
    const session = s,
      token = id!;
    this.running++;
    const cancel = () => session.abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const task = this.batch(session, request, token, guard);
    session.task = task;
    try {
      return await task;
    } catch (error) {
      session.abort.abort();
      await session.paths.return(undefined).catch(() => {});
      this.sessions.delete(token);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      session.task = undefined;
      this.running--;
    }
  }
  private async batch(s: Session, q: SearchRequest, token: string, guard: () => void): Promise<SearchBatch> {
    const readers: Array<{ path: string; reader: SearchReader }> = [];
    const candidates: Candidate[] = [];
    let bytes = 0,
      visited = 0,
      done = false;
    try {
      // Bound work per response, not total coverage. Even no-hit pages advance.
      let entries = 0;
      while (readers.length < 64 && bytes < 1024 * 1024 && entries++ < 512) {
        guard();
        if (s.abort.signal.aborted) throw new VaultError('cancelled');
        let next: IteratorResult<SearchPath>;
        try {
          next = await s.paths.next();
        } catch {
          s.warnings.add('note_unavailable');
          done = true;
          break;
        }
        if (next.done) {
          done = true;
          break;
        }
        if ('warning' in next.value) {
          s.warnings.add(next.value.warning);
          continue;
        }
        if (!('path' in next.value)) continue;
        const path = next.value.path;
        if (!path || s.seen.has(path) || !selected(path, q)) continue;
        s.memory += Buffer.byteLength(path) + 128;
        if (s.memory > 24 * 1024 * 1024) {
          s.warnings.add('capacity');
          done = true;
          break;
        }
        s.seen.add(path);
        visited++;
        try {
          const reader = await this.store.searchReader(s.root, path);
          readers.push({ path, reader });
          bytes += Buffer.byteLength(reader.text);
        } catch (error) {
          s.warnings.add(
            error instanceof VaultError && error.category === 'unsupported' ? 'unsupported' : 'note_unavailable'
          );
        }
      }
      const matched = new Map<number, number>();
      if (readers.length) {
        const paths = readers.map((_, i) => `/proc/self/fd/${i + 3}`);
        // Projection limits returned content, not which notes exist. Metadata-free
        // notes must remain candidates for folder-based consumers.
        const pattern = q.text ?? '^';
        await command(
          this.binary,
          [
            '--no-config',
            '--null',
            '--line-number',
            '--with-filename',
            '--no-heading',
            '--color',
            'never',
            '--ignore-case',
            '--no-mmap',
            '--threads',
            '1',
            '--max-count',
            '1',
            ...(q.text ? ['--fixed-strings', ...(q.text.includes('\n') ? ['--multiline'] : [])] : []),
            '-e',
            pattern,
            '--',
            ...paths,
          ],
          readers.map((r) => r.reader),
          s.abort.signal,
          (raw) => {
            // NUL-delimited generated fd name + numeric line prefix. Unlike rg
            // JSON, this cannot amplify a repeated literal into a submatch array.
            const end = raw.indexOf('\0'),
              index = paths.indexOf(raw.slice(0, end)),
              number = Number(/^(\d+):/.exec(raw.slice(end + 1))?.[1]);
            if (end < 0 || index < 0 || !Number.isSafeInteger(number) || number < 1) throw new Error();
            if (!matched.has(index)) matched.set(index, number);
          }
        );
      }
      for (let i = 0; i < readers.length; i++) {
        const { reader, path } = readers[i];
        guard();
        try {
          await reader.verify();
        } catch {
          s.warnings.add('note_unavailable');
          continue;
        }
        const line = matched.get(i) ?? (!q.text && reader.text.length === 0 ? 1 : undefined);
        if (line === undefined) continue;
        const candidate: Candidate = {
          path,
          hash: reader.hash,
          readAt: reader.readAt,
          line,
          snippet: reader.text.split('\n')[line - 1]?.replace(/\r$/, '').slice(0, 240) ?? '',
        };
        if (q.projection !== 'hits') {
          let content = reader.text;
          if (q.projection === 'frontmatter') {
            const opening = /^(?:\uFEFF)?---\r?\n/.exec(content);
            const closing = /^---[ \t]*\r?$/gm;
            closing.lastIndex = opening?.[0].length ?? 0;
            const end = opening ? closing.exec(content) : null;
            content = !opening ? '' : end ? content.slice(0, end.index + end[0].length) + '\n' : content;
          }
          if (Buffer.byteLength(content) > 65536) {
            candidate.limited = true;
            candidate.content = '';
          } else candidate.content = content;
        }
        candidates.push(candidate);
      }
      guard();
      if (s.abort.signal.aborted) throw new VaultError('cancelled');
      s.at = Date.now();
      const warnings = [...s.warnings];
      if (done) {
        await s.paths.return(undefined);
        this.sessions.delete(token);
      }
      return { candidates, nextCursor: done ? null : token, visited, warnings };
    } finally {
      await Promise.allSettled(readers.map((r) => r.reader.close()));
    }
  }
  has(id: string) {
    return this.sessions.has(id);
  }
  async close(revision: number, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.revision !== revision) return;
    s.abort.abort();
    await s.task?.catch(() => {});
    await s.paths.return(undefined).catch(() => {});
    this.sessions.delete(id);
  }
  async stop() {
    this.closed = true;
    clearInterval(this.sweep);
    for (const abort of this.probes.keys()) abort.abort();
    await Promise.allSettled([...this.probes.values()]);
    await Promise.all([...this.sessions].map(([id, s]) => this.close(s.revision, id)));
  }
}
