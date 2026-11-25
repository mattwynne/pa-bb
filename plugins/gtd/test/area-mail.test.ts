import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { areaMailBudget, areaNoteBudget, lookupAreaCorrespondence } from '../core/correspondence.ts';

const signal = new AbortController().signal;
const gmail = (id: number) => ({ title: 'Topic', url: `https://mail.google.com/mail/?authuser=one%40example.com#all/${id.toString(16)}` });
const fastmail = { title: 'Topic', url: 'https://app.fastmail.com/mail/Archive/sample' };
const ok = (unread: number) => ({ status: 'ok' as const, unread, sender: null, latestAt: null });

test('unread wins over unknown, and only complete zero or empty is clear', async () => {
  const notes = new Map([
    ['mixed', { links: [fastmail, gmail(1)], incomplete: false }],
    ['unavailable', { links: [gmail(2), gmail(3)], incomplete: false }],
    ['empty', { links: [], incomplete: false }],
    ['malformed', { links: [], incomplete: true }],
    ['clear', { links: [gmail(3)], incomplete: false }],
    ['fastmail', { links: [fastmail], incomplete: false }],
  ]);
  const lookedUp: string[] = [];
  const states = await lookupAreaCorrespondence([...notes.keys(), 'failed'], async id => notes.get(id), async url => {
    lookedUp.push(url);
    if (url === gmail(2).url) return { status: 'unavailable' };
    return ok(url === gmail(1).url ? 2 : 0);
  }, signal);
  assert.deepEqual(states.map(row => row.state), ['unread', 'incomplete', 'clear', 'incomplete', 'clear', 'incomplete', 'incomplete']);
  assert.deepEqual(lookedUp, [gmail(1).url, gmail(2).url, gmail(3).url]);
});

test('reads three notes at a time and skips remaining notes and lookups when budgets are reached', async () => {
  const projectIds = Array.from({ length: areaNoteBudget + 4 }, (_, i) => String(i));
  let reading = 0, peak = 0, reads = 0, calls = 0;
  const rows = await lookupAreaCorrespondence(projectIds, async id => {
    reads++;
    peak = Math.max(peak, ++reading);
    await setImmediate();
    reading--;
    const first = Number(id) * 2;
    return { links: [gmail(first), gmail(first + 1)], incomplete: false };
  }, async () => { calls++; return ok(0); }, signal);
  assert.equal(peak, 3);
  assert.equal(reads, areaNoteBudget);
  assert.equal(calls, areaMailBudget);
  assert.deepEqual(rows.map(row => row.id), projectIds.slice(0, areaNoteBudget));
  assert.deepEqual(rows.map(row => row.state), [
    ...Array(areaMailBudget / 2).fill('clear'), ...Array(areaNoteBudget - areaMailBudget / 2).fill('incomplete'),
  ]);
});
