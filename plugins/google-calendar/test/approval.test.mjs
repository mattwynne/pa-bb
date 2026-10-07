import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Compile the real component without requiring a BB runtime or a provider.
const temporary = resolve('test/approval.ui-test.generated.mjs');
const connection = resolve('test/approval-connection.ui-test.generated.mjs');
const compile = source => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
await writeFile(connection, compile(await readFile(resolve('connection-ui.tsx'), 'utf8')));
await writeFile(temporary, compile((await readFile(resolve('approval.tsx'), 'utf8')).replace('./connection-ui.js', './approval-connection.ui-test.generated.mjs')));
const { Approval, notificationConsequence, formatEventTime } = await import(`file://${temporary}`);
test.after(async () => { await unlink(temporary); await unlink(connection); });
const proposed = { account: 'person@example.test', calendarId: 'opaque-calendar', eventId: 'opaque-event', start: '2026-10-07T08:00:00-07:00', end: '2026-10-07T08:30:00-07:00', timeZone: 'America/Vancouver', sendUpdates: 'all' };
const payload = { operation: 'update', account: proposed.account, calendarId: proposed.calendarId, eventId: proposed.eventId, proposed, details: JSON.stringify(proposed), context: { calendarName: 'Team', currentEvent: { summary: 'Weekly catch-up', start: { dateTime: '2026-10-07T07:30:00-07:00', timeZone: 'America/Vancouver' }, end: { dateTime: '2026-10-07T08:00:00-07:00', timeZone: 'America/Vancouver' } } } };
const render = value => renderToStaticMarkup(createElement(Approval, { interaction: { payload: value }, submit: async () => {} }));

test('leads with verified title and current/proposed time; IDs and JSON are collapsed', () => {
  const html = render(payload);
  const visible = html.split('<details')[0];
  assert.match(visible, /Weekly catch-up/);
  assert.match(visible, /Current time/);
  assert.match(visible, /Proposed time/);
  assert.match(visible, /Oct 7, 2026/);
  assert.match(visible, /8:30/);
  assert.match(visible, /America\/Vancouver/);
  assert.match(visible, /Team/);
  assert.match(visible, /All attendees will be notified/);
  assert.doesNotMatch(visible, /opaque-calendar|opaque-event|CONFIRM CALENDAR|Update event\?/);
  assert.match(html, /<summary>Technical details<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.match(html, /opaque-calendar/);
  assert.match(html, /Decline change/);
  assert.doesNotMatch(html, />Cancel</);
  assert.match(html, /Declining leaves the event unchanged/);
});

test('missing or failed reads show the proposal without fabricated identity or before values', () => {
  for (const context of [null, {}, { currentEvent: null, calendarName: null }, { currentEvent: {} }]) {
    const visible = render({ ...payload, context }).split('<details')[0];
    assert.match(visible, /Event title unavailable/);
    assert.match(visible, /Current event information is unavailable/);
    assert.match(visible, /Proposed time/);
    assert.match(visible, /Name unavailable/);
    assert.doesNotMatch(visible, /Weekly catch-up|Team|Current time/);
  }
});

test('legacy pending JSON remains readable and malformed payloads do not crash', () => {
  assert.match(render({ operation: 'update', details: JSON.stringify(proposed) }), /Proposed time/);
  for (const p of [null, [], 'bad', { details: '{malformed' }]) assert.doesNotThrow(() => render(p));
  assert.match(render({ details: '{malformed' }), /Proposed values could not be displayed/);
});

test('renames, cleared values, moves and all-day ranges are explicit and escaped', () => {
  const html = render({ ...payload, proposed: { summary: '<New>', location: '', description: 'Notes', start: '2026-10-08', end: '2026-10-09', moveToCalendarId: 'other' }, context: { ...payload.context, destinationCalendarName: 'Personal', currentEvent: { ...payload.context.currentEvent, location: 'Office' } } });
  assert.match(html, /&lt;New&gt;/);
  assert.match(html, /Current: <\/span>Office/);
  assert.match(html, /Proposed: <\/span>\(empty\)/);
  assert.match(html, /Move to calendar: <strong>Personal/);
  assert.match(html, /End \(exclusive\)/);
  assert.match(html, /2026-10-08 \(all day\)/);
  const fallback = render({ ...payload, proposed: { moveToCalendarId: 'opaque-destination' }, context: null });
  assert.doesNotMatch(fallback.split('<details')[0], /opaque-destination/);
  assert.match(fallback, /Destination calendar ID<\/dt><dd>opaque-destination/);
});

test('notification text uses Google Calendar semantics, not company boundaries or false guarantees', () => {
  assert.match(notificationConsequence('externalOnly'), /do not use Google Calendar/);
  assert.match(notificationConsequence('none'), /Google may still send some emails/);
  assert.match(notificationConsequence(undefined), /not requested/);
  assert.match(notificationConsequence('unexpected'), /unknown/);
});

test('time formatting preserves offsets without zones and does not silently use browser timezone', () => {
  assert.match(formatEventTime(proposed.start), /2026-10-07T08:00:00-07:00/);
  assert.match(formatEventTime(proposed.start, 'invalid/zone'), /2026-10-07T08:00:00-07:00.*could not format/);
  assert.equal(formatEventTime(undefined), 'Not available');
  assert.equal(formatEventTime('invalid-time', 'America/Vancouver'), 'invalid-time');
  assert.equal(formatEventTime('2026-02-31T08:00:00-07:00', 'America/Vancouver'), '2026-02-31T08:00:00-07:00');
  assert.equal(formatEventTime('2026-10-07T08:00:00', 'America/Vancouver'), '2026-10-07T08:00:00 (America/Vancouver)');
  assert.match(formatEventTime('2026-10-07T08:00:00'), /timezone not supplied/);
  assert.match(formatEventTime('2026-11-01T01:30:00-07:00', 'America/Vancouver'), /PDT/);
  assert.match(formatEventTime('2026-11-01T01:30:00-08:00', 'America/Vancouver'), /PST/);
});
