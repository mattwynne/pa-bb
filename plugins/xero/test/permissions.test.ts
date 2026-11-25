import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedScopes, SCOPES, scopeGranted } from '../permissions.ts';
import { world, tokens } from './support.ts';
test('default scopes are preserved; broader grants are requested only after explicit configuration and reconnect', async () => {
  const w = world(); w.seed();
  assert.deepEqual(requestedScopes(), SCOPES);
  w.client.additionalScopes = 'accounting.contacts accounting.settings accounting.banktransactions files assets projects payroll.employees';
  const original = [...w.connection.scopes()]; assert.equal(w.calls.length, 0);
  const { url } = await w.connection.begin(), scopes = new URL(url).searchParams.get('scope')!.split(' ');
  assert.ok(scopes.includes('files')); assert.ok(!scopes.includes('accounting.contacts.read'));
  assert.deepEqual(w.connection.scopes(), original, 'begin and settings never upgrade an existing grant');
  w.setHandler(u => u.hostname === 'identity.xero.com' ? Response.json({ ...tokens, scope: scopes.join(' ') }) : Response.json([]));
  await w.connection.finish({ state: new URL(url).searchParams.get('state')!, code: 'SECRET_CODE' });
  assert.ok(w.connection.scopes().includes('files'));
});
test('explicit practice-only scope override stays separate from organisation scopes and survives token refresh', async () => {
  const w = world(); w.client.scopeOverride = 'offline_access practicemanager.job';
  const grant = w.client.scopeOverride;
  w.setHandler(u => u.hostname === 'identity.xero.com' ? Response.json({ ...tokens, scope: grant }) : Response.json([{ tenantId: '11111111-1111-4111-8111-111111111111', tenantName: 'Example practice', tenantType: 'PRACTICE' }]));
  const { url } = await w.connection.begin(); assert.equal(new URL(url).searchParams.get('scope'), grant);
  await w.connection.finish({ state: new URL(url).searchParams.get('state')!, code: 'SECRET_CODE' });
  assert.equal(w.connection.list()[0]!.tenantType, 'PRACTICE'); w.advance(1800_000); await w.connection.refresh();
  assert.deepEqual(w.connection.scopes(), grant.split(' '));
  assert.throws(() => requestedScopes('', 'practicemanager.job'), /offline_access/);
});
test('scope equivalence recognizes write/read and legacy grants without inventing permission', () => {
  assert.equal(scopeGranted('accounting.contacts.read', ['accounting.contacts']), true);
  assert.equal(scopeGranted('accounting.invoices', ['accounting.transactions']), true);
  assert.equal(scopeGranted('accounting.invoices', ['accounting.transactions.read']), false);
  assert.equal(scopeGranted('files', ['files.read']), false);
  assert.equal(scopeGranted('accounting.reports.banksummary.read', ['accounting.reports.read']), true);
  assert.throws(() => requestedScopes('https://SECRET.example'));
  assert.throws(() => requestedScopes('marketplace.billing'));
});
