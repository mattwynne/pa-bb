import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { grainSettingsFile, groupSettingsFile } from '../grain-settings.ts';
import { registerPhotos } from '../dist/server.js';

const endpoint = 'https://photos.example.test/mcp';
const token = 'synthetic-private-grain-token';
const privateText = 'SYNTHETIC_PRIVATE_CONTENT';
const caller = { experimental_caller: { kind: 'client' } };

function mockGrain() {
  const calls = [];
  let mode = 'good';
  const fetcher = async (input, init) => {
    const request = JSON.parse(init.body ?? 'null');
    calls.push(request?.method);
    assert.equal(String(input), endpoint);
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    if (mode === 'bad-auth') return new Response(`${privateText} ${token}`, { status: 401 });
    if (!request) return new Response(null, { status: 405 });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Grain fixture', version: '1' } };
    else if (request.method === 'tools/list') result = !request.params?.cursor ? { tools: [tool('list_galleries')], nextCursor: 'next' } : { tools: [tool('get_photo')] };
    else if (request.method === 'tools/call') {
      assert.equal(request.params.name, 'get_photo');
      result = mode === 'tool-failure' ? { isError: true, content: [{ type: 'text', text: `${privateText} ${token}` }] }
        : mode === 'echo-token' ? { content: [{ type: 'text', text: token }] }
          : { content: [{ type: 'text', text: 'Fixture photo' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] };
    } else assert.fail(`Unexpected request ${request.method}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  return { fetcher, calls, setMode(value) { mode = value; } };
}
function tool(name) { return { name, inputSchema: { type: 'object', properties: {} } }; }

async function withHost(run) {
  let available = false;
  const host = createFakePluginHost({ pluginId: 'photos', agentSkillIds: ['photos'], sdk: { plugins: {
    callRpc({ pluginId, method }) {
      assert.equal(pluginId, 'icloud');
      if (!available) throw new Error(privateText);
      if (method === 'photosStatus') return 'shared';
      assert.equal(method, 'photosBrowse');
      return { ok: false, error: 'Open the album again.' };
    },
  } } });
  const grain = mockGrain();
  const temp = await mkdtemp('/tmp/photos-settings-test-');
  const grainStorage = grainSettingsFile(join(temp, 'grain'));
  const groupStorage = groupSettingsFile(join(temp, 'grain'));
  await registerPhotos(host.bb, { grainStorage, groupStorage, grainFetch: grain.fetcher });
  try {
    const { behavior } = host.harness;
    const post = async (path, json) => (await behavior.fetchHttp("POST", `/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json),
    })).json();
    const rpc = (name, input) => behavior.callRpc(name, input, caller);
    await run({ host, grain, grainStorage, groupStorage, temp, post, rpc, connect: () => { available = true; } });
  } finally { await host.harness.lifecycle.dispose(); await rm(temp, { recursive: true, force: true }); }
}

test('Photos delegates library access to iCloud and offers recovery if the capability is unavailable', async () => {
  await withHost(async ({ host, rpc, connect }) => {
    assert.deepEqual(await rpc('status', null), { apple: 'unavailable', grain: null, group: null });
    const failure = await rpc('browse', { parent: null });
    assert.equal(failure.ok, false);
    assert.doesNotMatch(JSON.stringify([failure, host.harness.inspection.logEntries]), new RegExp(privateText));
    connect();
    assert.deepEqual(await rpc('status', null), { apple: 'shared', grain: null, group: null });
    assert.equal((await rpc('browse', { parent: null })).error, 'Open the album again.');
    assert.equal(host.harness.inspection.registrations.httpRoutes.some(route => route.path.includes('apple')), false);
  });
});

test('Grain verifies before saving and exposes paginated tools with safe failure diagnostics', async () => {
  await withHost(async ({ host, grain, grainStorage, post, rpc }) => {
    const behavior = host.harness.behavior;
    const resolve = () => behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.equal((await resolve()).tools.length, 0);
    assert.equal((await post('grain-connect', { endpoint: 'http://photos.example.test/mcp', token })).ok, false);
    assert.equal(grain.calls.length, 0);
    assert.equal((await post('grain-connect', { endpoint, token })).status.grain, endpoint);
    assert.deepEqual(await grainStorage.get(), { endpoint, token });
    assert.equal((await resolve()).tools.length, 2);
    assert.deepEqual(await rpc('checkGrain', null), { ok: true });
    const list = await behavior.callAgentTool('grain_list_tools', {});
    assert.deepEqual(JSON.parse(list.content[0].text).map(item => item.name), ['list_galleries', 'get_photo']);
    const call = name => behavior.callAgentTool('grain_call_tool', { name });
    assert.equal((await call('get_photo')).content[1].type, 'image');
    assert.equal((await call('absent')).isError, true);
    assert.equal(grain.calls.filter(method => method === 'tools/call').length, 1);
    grain.setMode('echo-token');
    const echo = await call('get_photo');
    grain.setMode('tool-failure');
    const toolError = await call('get_photo');
    grain.setMode('bad-auth');
    const denied = await post('grain-connect', { endpoint, token });
    assert.equal(denied.ok, false);
    assert.equal((await rpc('status', null)).grain, endpoint);
    assert.equal(echo.isError, true);
    assert.equal(toolError.isError, true);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /Grain tool_call grain_tool/);
    assert.match(logs, /Grain handshake grain_auth/);
    assert.doesNotMatch(logs + JSON.stringify([echo, toolError, denied]), new RegExp(`${token}|${privateText}`));
    assert.equal((await post('grain-disconnect', {})).status.grain, null);
    assert.equal((await resolve()).tools.length, 0);
  });
});

test('Journal sharing group is validated, stored privately and cleared', async () => {
  await withHost(async ({ host, groupStorage, temp, post, rpc }) => {
    const group = { handle: 'family.example.test', did: 'did:plc:abcdefghijklmnopqrstuvwx' };
    for (const bad of [{ handle: 'not a handle', did: null }, { handle: 'family.example.test', did: 'did:plc:short' },
      { handle: 'family.example.test' }, { ...group, extra: privateText }]) {
      const reply = await post('group-save', bad);
      assert.equal(reply.ok, false);
      assert.doesNotMatch(JSON.stringify(reply), new RegExp(privateText));
    }
    assert.equal(await groupStorage.get(), null);
    assert.deepEqual((await post('group-save', { handle: ' Family.Example.Test ', did: null })).status.group, { handle: 'family.example.test', did: null });
    assert.deepEqual((await post('group-save', group)).status.group, group);
    assert.deepEqual((await rpc('status', null)).group, group);
    const info = await stat(join(temp, 'grain', 'group.json'));
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await post('group-clear', {})).status.group, null);
    assert.equal(await groupStorage.get(), null);
    assert.equal(host.harness.inspection.logEntries.length, 0);
  });
});

test('Journal can load the HEIC decoder from the plugin', async () => {
  await withHost(async ({ host }) => {
    const response = await host.harness.behavior.fetchHttp('GET', '/libheif.mjs');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.arrayBuffer()).byteLength > 1_000_000);
  });
});

test('Journal keeps gallery text within Grain limits and does not pretend to post', async () => {
  const { clampBytes, byteLength, shareGallery, TITLE_LIMIT } = await import('../share.ts');
  assert.equal(byteLength(clampBytes('é'.repeat(80), TITLE_LIMIT)), 100);
  assert.equal(clampBytes('🌲'.repeat(30), TITLE_LIMIT), '🌲'.repeat(25));
  assert.equal(clampBytes('Short', TITLE_LIMIT), 'Short');
  const result = await shareGallery({ title: 'A walk', words: '', photos: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /isn’t connected yet/);
  const { takenAt } = await import('../journal-images.ts');
  assert.equal(await takenAt(new ArrayBuffer(8), '2015-01-16 09.34.21.jpg'), '2015-01-16T09:34:21');
  assert.equal(await takenAt(new ArrayBuffer(8), 'IMG_0001.HEIC'), null);
});
