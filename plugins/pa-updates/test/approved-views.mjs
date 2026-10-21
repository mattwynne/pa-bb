import assert from 'node:assert/strict';
import { localDecision } from '../core/decision.ts';
export const approvedViews = ['approved_current', 'approved_checking', 'approved_local', 'approved_updates', 'approved_local_updates', 'approved_failed', 'approved_results'];
const versions = { fastmail: '0.1.7', 'google-calendar': '0.1.1', 'google-drive': '0.1.1', icloud: '0.3.2', obsidian: '0.3.1', 'pa-updates': '0.2.8' };
const next = { 'google-calendar': '0.1.2', icloud: '0.3.3', obsidian: '0.3.2', 'pa-updates': '0.2.9' };
export function approvedJob(state, choices = []) {
  const decisions = new Map(choices.map(row => [row.id, row.choice]));
  return { id: '22222222-2222-4222-8222-222222222222', reviewId: state.review.id, phase: 'complete', failure: null, syncReserved: false, selfIntent: null, bbIntent: null, confirmInterruptingThreads: false,
    receipts: state.review.rows.map(row => { const choice = row.decision === 'automatic' ? 'install' : decisions.get(row.id) ?? 'keep'; return { id: row.id, choice, before: row.installed, preview: row.available, actual: choice === 'install' ? row.available : row.installed, outcome: choice === 'install' ? 'updated' : 'kept' }; }),
    runtimeReceipts: state.review.runtime.rows.filter(row => row.state === 'ready').map(row => ({ id: row.id, before: row.installed, preview: row.available, actual: row.available, source: row.source, outcome: 'updated' })) };
}
export function approvedState(view, base) {
  const state = structuredClone(base); state.review.rows = [];
  state.review.inventory = Object.entries(versions).map(([id, installed]) => ({ id, installed, state: 'current', local: 'stock', prerequisite: null, development: 'clean' }));
  state.review.runtime.rows.forEach(row => { row.installed = { pi: '1.3.0', codex: '0.163.0', bb: '0.46.1' }[row.id]; row.available = null; row.state = 'current'; });
  const component = id => state.review.inventory.find(row => row.id === id);
  if (['approved_local', 'approved_local_updates', 'approved_results'].includes(view)) {
    component(view === 'approved_results' ? 'obsidian' : 'icloud').development = 'unpublished';
    if (view !== 'approved_results') component('obsidian').local = 'custom';
  }
  const offers = view === 'approved_updates' ? ['google-calendar', 'pa-updates'] : view === 'approved_local_updates' ? ['icloud', 'obsidian', 'google-calendar', 'pa-updates'] : view === 'approved_results' ? ['google-calendar', 'icloud', 'pa-updates'] : [];
  if (view === 'approved_results') component('icloud').local = 'custom';
  for (const id of offers) { const item = component(id); item.state = 'offered'; state.review.rows.push({ id, installed: item.installed, available: next[id], local: item.local, development: item.development, decision: localDecision(item), fingerprint: `fixture-${id}`, prerequisite: null }); }
  if (['approved_updates', 'approved_results'].includes(view)) for (const row of state.review.runtime.rows) if (row.id !== 'codex') { row.state = 'ready'; row.available = row.id === 'pi' ? '1.4.0' : '0.46.2'; }
  if (view === 'approved_updates') state.review.runtime.runningThreadCount = 2;
  if (view === 'approved_failed') { component('google-drive').state = 'unavailable'; component('google-drive').prerequisite = 'unavailable'; component('icloud').development = 'unknown'; Object.assign(state.review.runtime.rows.find(row => row.id === 'bb'), { state: 'unavailable', reason: 'unavailable' }); }
  state.offers.available = !!offers.length;
  if (view === 'approved_results') {
    state.job = approvedJob(state); state.job.phase = 'attention'; state.job.failure = 'unavailable'; state.offers = null;
    Object.assign(state.job.receipts.find(row => row.id === 'pa-updates'), { outcome: 'pending', actual: null });
    const bb = state.job.runtimeReceipts.find(row => row.id === 'bb'); Object.assign(bb, { outcome: 'failed', actual: bb.before });
    state.job.runtimeReceipts.find(row => row.id === 'pi').actual = '1.4.1';
  }
  return state;
}
export async function assertApproved({ view, section, page, writes }) {
  if (view === 'approved_checking') return; // The harness drives real realtime progress below.
  for (const name of ['Fastmail', 'Calendar', 'Google Drive', 'iCloud', 'Obsidian', 'PA updater', 'Pi', 'Codex', 'BB']) assert.equal(await section.getByText(name, { exact: true }).count(), 1);
  const apply = section.getByRole('button', { name: 'Update PA', exact: true });
  assert.equal(await apply.count(), ['approved_updates', 'approved_local_updates'].includes(view) ? 1 : 0);
  assert.equal(await section.getByRole('checkbox').count(), view === 'approved_updates' ? 1 : 0);
  if (view === 'approved_current') assert.equal(await section.locator('.pa-update-check').count(), 9);
  if (view === 'approved_local') { assert.equal(await section.locator('.pa-development-badge').count(), 2); assert.equal(await section.locator('.pa-update-check').count(), 7); }
  if (view === 'approved_failed') { assert.ok(!(await section.textContent()).includes('Completed changes')); assert.equal(await section.locator('.pa-update-check').count(), 6); assert.equal(await section.locator('.pa-development-unknown').count(), 1); }
  if (view === 'approved_results') {
    assert.equal(await section.locator('.pa-update-check').count(), 3, 'a failed BB write must not invent failed reads of untouched components');
    const self = section.locator('.pa-update-results li').filter({ has: page.getByText('PA updater', { exact: true }) });
    assert.ok((await self.textContent()).includes('0.2.8 · Not updated')); assert.equal(writes.length, 0);
  }
  if (view === 'approved_local_updates') {
    const keeps = section.getByRole('button', { name: 'Keep local', exact: true }); assert.equal(await keeps.count(), 2);
    for (const keep of await keeps.all()) assert.equal(await keep.getAttribute('aria-pressed'), 'true');
    for (const name of ['iCloud', 'Obsidian']) { const row = section.locator('.pa-update-row').filter({ has: page.getByText(name, { exact: true }) }); assert.ok(!(await row.textContent()).includes('→')); assert.equal(await row.locator('.pa-development-badge').textContent(), 'Local changes'); }
    const choose = async name => { await section.getByRole('button', { name, exact: true }).focus(); await page.keyboard.press('Enter'); };
    await choose('Install all released'); for (const install of await section.getByRole('button', { name: 'Install released version', exact: true }).all()) assert.equal(await install.getAttribute('aria-pressed'), 'true');
    await choose('Keep all local'); for (const keep of await keeps.all()) assert.equal(await keep.getAttribute('aria-pressed'), 'true');
  }
}
