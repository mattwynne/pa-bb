import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubFeed, boundedText } from '../adapters/github.ts';
import { record } from './fixtures.ts';
const signal = () => new AbortController().signal;
const release = (tag = record().identity, published = '2026-10-19T12:00:00Z') => ({ tag_name: tag, published_at: published, draft: false, prerelease: false });
test('select stable dedicated PA tags, ignore drafts/prereleases; derive trusted download address', async () => {
  const urls: string[] = [];
  const fake: typeof fetch = async input => {
    const url = String(input); urls.push(url);
    return new Response(url.includes('/download/') ? JSON.stringify(record()) : JSON.stringify([
      release('other-tag'), { ...release('pa-release-' + 'b'.repeat(40)), draft: true }, { ...release('pa-release-' + 'c'.repeat(40)), prerelease: true }, release(),
    ]));
  };
  assert.equal((await githubFeed(fake)(signal()))?.identity, record().identity);
  assert.equal(urls[1], `https://github.com/mattwynne/pa-bb/releases/download/${record().identity}/pa-release.json`);
  assert.equal(await githubFeed(async () => new Response('[]'))(signal()), null);
});
test('bounded pagination fails incomplete listings instead of returning no release', async () => {
  let count = 0;
  await assert.rejects(githubFeed(async () => { count++; return new Response(JSON.stringify(Array.from({ length: 50 }, (_, i) => release('other-' + i)))); })(signal()), /incomplete/);
  assert.equal(count, 4);
  let pages = 0;
  const feed = githubFeed(async () => { pages++; return pages === 1 ? new Response(JSON.stringify(Array.from({ length: 50 }, () => release('other')))) : new Response('PRIVATE_SENTINEL', { status: 503 }); });
  await assert.rejects(feed(signal()), /http/);
});
test('network, HTTP, malformed, oversized and untrusted redirects are safe fixed failures', async () => {
  const tests: [typeof fetch, RegExp][] = [
    [async () => { throw new Error('PRIVATE_SENTINEL credentials'); }, /network/],
    [async () => new Response('PRIVATE_SENTINEL', { status: 403 }), /http/],
    [async () => new Response('PRIVATE_SENTINEL'), /invalid/],
    [async () => new Response('{}'), /invalid/],
    [async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), /invalid/],
    [async () => new Response('', { status: 302, headers: { location: 'https://evil.invalid/PRIVATE_SENTINEL' } }), /invalid/],
  ];
  for (const [fake, pattern] of tests) { try { await githubFeed(fake)(signal()); assert.fail('must fail'); } catch (error) { assert.match(String(error), pattern); assert.ok(!String(error).includes('PRIVATE_SENTINEL')); } }
  await assert.rejects(boundedText('http://github.com/private', 10, signal()), /invalid/);
});
