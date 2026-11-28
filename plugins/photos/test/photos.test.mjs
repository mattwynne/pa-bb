import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { grainSettingsFile } from '../grain-settings.ts';
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
  await registerPhotos(host.bb, { grainStorage, grainFetch: grain.fetcher });
  try {
    const { behavior } = host.harness;
    const post = async (path, json) => (await behavior.fetchHttp("POST", `/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json),
    })).json();
    const rpc = (name, input) => behavior.callRpc(name, input, caller);
    await run({ host, grain, grainStorage, post, rpc, connect: () => { available = true; } });
  } finally { await host.harness.lifecycle.dispose(); await rm(temp, { recursive: true, force: true }); }
}

test('Photos delegates library access to iCloud and offers recovery if the capability is unavailable', async () => {
  await withHost(async ({ host, rpc, connect }) => {
    assert.deepEqual(await rpc('status', null), { apple: 'unavailable', grain: null });
    const failure = await rpc('browse', { parent: null });
    assert.equal(failure.ok, false);
    assert.doesNotMatch(JSON.stringify([failure, host.harness.inspection.logEntries]), new RegExp(privateText));
    connect();
    assert.deepEqual(await rpc('status', null), { apple: 'shared', grain: null });
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
