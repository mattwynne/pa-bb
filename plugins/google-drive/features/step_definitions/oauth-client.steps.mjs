import assert from 'node:assert/strict';
import { Before, After, Given, When, Then } from '@cucumber/cucumber';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import drivePlugin from '../../dist/server.js';
import calendarPlugin from '../../../google-calendar/dist/server.js';
import { createBbStore as driveStore } from '../../adapters/bb-store.mjs';
import { createBbStore as calendarStore } from '../../../google-calendar/adapters/bb-store.mjs';
import { SCOPES as driveScopes } from '../../core/service.mjs';
import { SCOPES as calendarScopes } from '../../../google-calendar/core/service.mjs';

const pluginId = name => name === 'Drive' ? 'google-drive' : 'google-calendar';
const factory = name => name === 'Drive' ? drivePlugin : calendarPlugin;
const storeAdapter = name => name === 'Drive' ? driveStore : calendarStore;
const importMethod = name => name === 'Drive' ? 'importCalendarOAuthClient' : 'importDriveOAuthClient';
const exportMethod = name => name === 'Drive' ? 'exportOAuthClientForCalendar' : 'exportOAuthClientForDrive';
const scopes = name => name === 'Drive' ? driveScopes : calendarScopes;

Before(function () { this.hosts = new Map(); this.secret = 'private-synthetic-client-secret'; this.sourceRequests = 0; });
After(async function () {
  for (const { harness } of this.hosts.values()) await harness.lifecycle.dispose();
});
async function install(world, name, configured = false) {
  const existing = world.hosts.get(name);
  if (existing) return existing;
  const host = createFakePluginHost({ pluginId: pluginId(name), appUrl: 'https://bb.example',
    settings: configured ? { clientId: 'synthetic-web-client', clientSecret: world.secret } : {} });
  await factory(name)(host.bb);
  world.hosts.set(name, host);
  return host;
}
Given(/^(Calendar|Drive) has a configured Google Web OAuth client$/, async function (name) {
  this.source = name;
  await install(this, name, true);
});
Given(/^(Calendar|Drive) has no configured client or accounts$/, async function (name) {
  this.destination = name;
  await install(this, name);
});
Given(/^(Calendar|Drive) presents its HTTPS redirect URI for registration with that Web client$/, async function (name) {
  // Registration at Google Cloud is an external prerequisite, not something BB
  // can inspect. Verify the exact HTTPS destination URI that BB presents.
  const status = await this.hosts.get(name).harness.behavior.callRpc('status', null);
  assert.equal(status.redirectUri, `https://bb.example/api/v1/plugins/${pluginId(name)}/http/callback`);
});
Given(/^(Calendar|Drive) is (absent|unconfigured)$/, async function (name, condition) {
  this.source = name;
  if (condition === 'unconfigured') await install(this, name);
});
Given(/^(Calendar|Drive) has a connected Google account$/, async function (name) {
  this.destination = name;
  const host = await install(this, name, true);
  await host.harness.behavior.setSettings({ clientId: 'existing-destination-client', clientSecret: 'existing-destination-secret' });
  const store = storeAdapter(name)(host.bb.storage.database(), () => {});
  await store.addAccount({ subject: 'existing-subject', email: 'alice@example.test', refreshToken: 'synthetic-refresh' });
});
When(/^the owner chooses to copy the client from (Calendar|Drive) to (Calendar|Drive)$/, async function (source, destination) {
  assert.notEqual(source, destination);
  const dest = this.hosts.get(destination);
  const src = this.hosts.get(source);
  if (src) dest.harness.sdk.stub('plugins.callRpc', async args => {
    this.sourceRequests++;
    assert.equal(args.pluginId, pluginId(source));
    assert.equal(args.method, exportMethod(source));
    return src.harness.behavior.callRpc(args.method, args.input,
      { experimental_caller: { kind: 'plugin', pluginId: pluginId(destination) } });
  });
  try { this.result = await dest.harness.behavior.callRpc(importMethod(destination), null); }
  catch (error) { this.failure = error; }
});
When(/^a (browser or CLI|unrelated plugin) requests (Calendar|Drive)'s client credentials$/, async function (caller, source) {
  const host = this.hosts.get(source);
  try { this.result = await host.harness.behavior.callRpc(exportMethod(source), null,
    caller === 'browser or CLI' ? undefined : { experimental_caller: { kind: 'plugin', pluginId: 'fastmail' } }); }
  catch (error) { this.failure = error; }
});
When(/^(Calendar|Drive) is removed$/, async function (name) {
  await this.hosts.get(name).harness.lifecycle.dispose();
  this.hosts.delete(name);
});
Then(/^(Calendar|Drive) is configured with its own stored copy of that client$/, async function (name) {
  assert.equal(this.result?.imported, true);
  const host = this.hosts.get(name);
  assert.equal((await host.harness.behavior.callRpc('status', null)).configured, true);
  const url = new URL((await host.harness.behavior.callRpc('beginConnect', null)).url);
  assert.equal(url.searchParams.get('client_id'), 'synthetic-web-client');
});
Then(/^(Calendar|Drive) still has no connected accounts$/, async function (name) {
  assert.deepEqual((await this.hosts.get(name).harness.behavior.callRpc('status', null)).accounts, []);
});
Then(/^authorization for (Calendar|Drive) requests only its own scopes$/, async function (name) {
  const url = new URL((await this.hosts.get(name).harness.behavior.callRpc('beginConnect', null)).url);
  assert.deepEqual(url.searchParams.get('scope').split(' '), scopes(name));
});
Then(/^neither the browser result nor plugin logs contain the client secret$/, function () {
  assert.doesNotMatch(JSON.stringify(this.result), /private-synthetic-client-secret/);
  for (const { harness } of this.hosts.values()) assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-synthetic-client-secret/);
});
Then(/^(Calendar|Drive) remains configured after reload$/, async function (name) {
  let { harness } = this.hosts.get(name);
  ({ harness } = await harness.lifecycle.reload(factory(name)));
  this.hosts.set(name, { harness });
  assert.equal((await harness.behavior.callRpc('status', null)).configured, true);
  assert.equal(new URL((await harness.behavior.callRpc('beginConnect', null)).url).searchParams.get('client_id'), 'synthetic-web-client');
});
Then(/^the request is denied without exposing the secret$/, function () {
  assert.match(this.failure?.message || '', /restricted/);
  assert.doesNotMatch(this.failure.message, /private-synthetic-client-secret/);
});
Then(/^the import fails without changing (Calendar|Drive)'s client settings$/, async function (name) {
  assert.ok(this.failure);
  assert.equal((await this.hosts.get(name).harness.behavior.callRpc('status', null)).configured, false);
});
Then(/^the import is refused before requesting (Calendar|Drive)'s secret$/, function (_source) {
  assert.match(this.failure?.message || '', /Disconnect .* accounts/);
  assert.equal(this.sourceRequests, 0);
});
Then(/^(Calendar|Drive)'s connected account remains unchanged$/, async function (name) {
  const host = this.hosts.get(name);
  const store = storeAdapter(name)(host.bb.storage.database(), () => {});
  assert.deepEqual((await store.accounts()).map(record => record.email), ['alice@example.test']);
  const url = new URL((await host.harness.behavior.callRpc('beginConnect', null)).url);
  assert.equal(url.searchParams.get('client_id'), 'existing-destination-client');
});
