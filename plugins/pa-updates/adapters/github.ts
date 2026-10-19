import { CheckError } from '../core/model.ts';
import { identitySchema, MAX_RECORD, REPOSITORY } from '../core/release.ts';
const API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const allowed = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export async function boundedText(url: string, limit: number, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  const timeout = AbortSignal.timeout(10_000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !allowed.has(target.hostname) || target.username || target.password || (target.port && target.port !== '443')) throw new CheckError('invalid');
      const response = await request(url, { signal: combined, redirect: 'manual', headers: { Accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'pa-updates' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location'); if (!location || redirects === 3) throw new CheckError('http');
        url = new URL(location, url).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new CheckError('http'); }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new CheckError('invalid'); }
      const reader = response.body?.getReader(); if (!reader) throw new CheckError('invalid');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new CheckError('invalid'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    }
    throw new CheckError('http');
  } catch (error) { if (error instanceof CheckError) throw error; throw new CheckError(signal.aborted ? 'cancelled' : 'network'); }
}
export function githubFeed(request: typeof fetch = fetch) {
  return async (signal: AbortSignal): Promise<{ text: string; identity: string } | null> => {
    // Complete at most four pages. Never infer absence/latest from a truncated list.
    const candidates: { tag: string; published: string }[] = [];
    let complete = false;
    for (let page = 1; page <= 4; page++) {
      let records: unknown;
      try { records = JSON.parse(await boundedText(`${API}?per_page=50&page=${page}`, 2 * 1024 * 1024, signal, request)); }
      catch (error) { if (error instanceof CheckError) throw error; throw new CheckError('invalid'); }
      if (!Array.isArray(records) || records.length > 50) throw new CheckError('invalid');
      for (const record of records) {
        if (!record || typeof record !== 'object' || typeof record.tag_name !== 'string' || typeof record.draft !== 'boolean' || typeof record.prerelease !== 'boolean') throw new CheckError('invalid');
        if (!identitySchema.safeParse(record.tag_name).success || record.draft || record.prerelease) continue;
        if (typeof record.published_at !== 'string' || !Number.isFinite(Date.parse(record.published_at))) throw new CheckError('invalid');
        if (candidates.some(candidate => candidate.tag === record.tag_name)) throw new CheckError('invalid');
        candidates.push({ tag: record.tag_name, published: record.published_at });
      }
      if (records.length < 50) { complete = true; break; }
    }
    if (!complete) throw new CheckError('incomplete');
    candidates.sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || b.tag.localeCompare(a.tag));
    const candidate = candidates[0]; if (!candidate) return null;
    // Never use a record-supplied URL, repository, tag target or filesystem path.
    const text = await boundedText(`https://github.com/${REPOSITORY}/releases/download/${candidate.tag}/pa-release.json`, MAX_RECORD, signal, request);
    return { text, identity: candidate.tag };
  };
}
