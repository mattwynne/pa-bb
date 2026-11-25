import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { areaMailBudget, areaNoteBudget, lookupAreaCorrespondence, uniqueConversations, type MailStatus } from '../core/correspondence.ts';

const signal = new AbortController().signal;
const gmail = (id: number) => ({ title: 'Topic', url: `https://mail.google.com/mail/?authuser=one%40example.com#all/${id.toString(16)}` });
const fastmail = { title: 'Topic', url: 'https://app.fastmail.com/mail/Archive/S_anchor?u=1234abcd' };
const fastmailPair = { title: 'Re: Topic', url: 'https://app.fastmail.com/mail/Sent/T_one.S_reply?u=1234abcd' };
const ok = (unread: number) => ({ status: 'ok' as const, unread, sender: null, latestAt: null });

test('unread wins over unknown, and only complete zero or empty is clear', async () => {
  const notes = new Map([
    ['mixed', { links: [fastmail, gmail(1)], incomplete: false }],
    ['unavailable', { links: [gmail(2), gmail(3)], incomplete: false }],
    ['empty', { links: [], incomplete: false }],
    ['malformed', { links: [], incomplete: true }],
    ['clear', { links: [gmail(3)], incomplete: false }],
    ['fastmail', { links: [fastmail, fastmailPair], incomplete: false }],
    ['wrong-account', { links: [{ ...fastmail, url: fastmail.url.replace('1234abcd', '2234abcd') }], incomplete: false }],
  ]);
  const lookedUp: string[] = [];
  const states = await lookupAreaCorrespondence([...notes.keys(), 'failed'], async id => notes.get(id), async url => {
    lookedUp.push(url);
    if (url === gmail(2).url) return { status: 'unavailable' };
    if (url.endsWith('2234abcd')) return { status: 'account_mismatch' };
    return ok(url === fastmail.url || url === fastmailPair.url ? 2 : 0);
  }, signal);
  assert.deepEqual(states.map(row => row.state), ['unread', 'incomplete', 'clear', 'incomplete', 'clear', 'unread', 'incomplete', 'incomplete']);
  assert.deepEqual(lookedUp, [fastmail.url, gmail(1).url, gmail(2).url, gmail(3).url, fastmailPair.url, fastmail.url.replace('1234abcd', '2234abcd')]);
});

test('verified Fastmail duplicates keep the first saved title and href in order', () => {
  const other = { title: 'Distinct conversation', url: fastmail.url.replace('S_anchor', 'S_other') };
  const unresolved = { title: 'Unresolved', url: fastmail.url.replace('S_anchor', 'S_gone') };
  const links = [fastmail, gmail(1), fastmailPair, other, unresolved];
  const status = new Map<string, MailStatus>([
    [fastmail.url, { ...ok(2), threadKey: 'a'.repeat(64) }],
    [fastmailPair.url, { ...ok(2), threadKey: 'a'.repeat(64) }],
    [other.url, { ...ok(2), threadKey: 'b'.repeat(64) }],
    [unresolved.url, { status: 'not_found' }],
    [gmail(1).url, ok(2)],
  ]);
  assert.deepEqual(uniqueConversations(links, status), [fastmail, gmail(1), other, unresolved]);
  assert.deepEqual(uniqueConversations(links, new Map()), links);
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
