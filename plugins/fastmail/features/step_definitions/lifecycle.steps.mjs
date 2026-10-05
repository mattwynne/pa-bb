import { Before, Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FastmailConnection, callbackUrl, parseCallback } from '../../core.mjs';

Before(function () {
  let record = {};
  const store = {
    get: () => structuredClone(record), patch: p => { record = { ...record, ...p }; },
    remove: (...keys) => { keys.forEach(key => delete record[key]); }, clear: () => { record = {}; },
  };
  this.registered = []; this.calls = [];
  this.redirect = callbackUrl('http://127.0.0.1:38886', 'fastmail');
  this.connection = new FastmailConnection({ store, redirect: this.redirect, register: tool => this.registered.push(tool), connect: () => ({
    client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: [
      { name: 'search_mail', description: 'Mail read', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'create_event', description: 'Calendar write', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ] }), callTool: async args => { this.calls.push(args); return { content: [] }; } },
    transport: { finishAuth: async () => {}, close: async () => {} },
  }) });
});
Given('a standalone Fastmail installation beside Google Calendar', function () {
  const marketplace = JSON.parse(readFileSync(new URL('../../../../marketplace.json', import.meta.url), 'utf8'));
  const plugins = new Map(marketplace.plugins.map(entry => [entry.id, entry]));
  for (const id of ['fastmail', 'google-calendar']) {
    const entry = plugins.get(id);
    assert.equal(entry.source.git.subdir, `plugins/${id}`);
    const manifest = JSON.parse(readFileSync(new URL(`../../../${id}/package.json`, import.meta.url), 'utf8'));
    assert.ok(manifest.bb.server && manifest.bb.app, `${id} has an independently installable BB manifest`);
  }
});
When('Fastmail grants a mail read and a calendar mutation tool', async function () { await this.connection.open(); this.ids = this.connection.toolNames(); });
Then('both granted Fastmail tools are selectable with provider schemas', function () {
  assert.equal(this.ids.length, 2); assert.deepEqual(this.registered[1].parameters.properties, { title: { type: 'string' } });
});
Then('Google Calendar remains independent', function () {
  const manifest = JSON.parse(readFileSync(new URL('../../../google-calendar/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'bb-plugin-google-calendar');
  assert.equal(manifest.bb.server, './server.ts');
  assert.ok(!this.registered.some(tool => tool.name.startsWith('gcal_')));
});
Given('Fastmail authorization is pending', async function () {
  this.state = await this.connection.provider.state(); this.connection.provider.saveCodeVerifier('mock-verifier');
  this.callback = `${this.redirect}?state=${this.state}&code=mock-code`;
});
When('a callback for another plugin is pasted', function () {
  assert.throws(() => parseCallback(this.callback.replace('/fastmail/', '/other/'), this.redirect));
});
Then('the callback is rejected before token exchange', function () { assert.equal(this.connection.provider.codeVerifier(), 'mock-verifier'); });
When('the valid callback is consumed', function () { this.connection.provider.consume(parseCallback(this.callback, this.redirect)); });
Then('replay of that callback is rejected', function () { assert.throws(() => this.connection.provider.consume(parseCallback(this.callback, this.redirect))); });
When('Fastmail is disconnected', async function () { await this.connection.disconnect(); });
Then('no cached Fastmail mutation can run', async function () {
  assert.deepEqual(this.connection.toolNames(), []);
  await assert.rejects(this.connection.call(this.ids[1], { title: 'mock' }), /unavailable/);
  assert.equal(this.calls.length, 0);
});
Then('disabling Fastmail cannot reconnect it', async function () { await this.connection.disable(); await assert.rejects(this.connection.open(), /disabled/); });
