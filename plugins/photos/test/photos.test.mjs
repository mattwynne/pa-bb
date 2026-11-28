import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { grainSettingsFile } from '../grain-settings.ts';
import { applePhotos } from '../apple.ts';
import { rcloneRemote } from '../rclone.ts';
import { registerPhotos } from '../dist/server.js';

const endpoint = 'https://photos.example.test/mcp';
const token = 'synthetic-private-grain-token';
const appleSecret = 'synthetic-private-apple-password';
const privateText = 'SYNTHETIC_PRIVATE_CONTENT';
const caller = { experimental_caller: { kind: 'client' } };
const entry = (parent, name, directory = false) => ({ Path: parent ? `${parent}/${name}` : name, Name: name, IsDir: directory, Size: 4 });
const bytes = Buffer.from([0x00, 0xff, 0x01, 0x00]);

function mockApple() {
  const calls = [];
  let reset = 0;
  return { calls, resets: () => reset, closed: false, fail: false,
    async resetAccount() { reset++; },
    async rpc(method, body) {
      calls.push({ method, body });
      if (this.fail) throw new Error(`${privateText} ${appleSecret}`);
      if (method === 'config/create') return { State: 'private-challenge', Option: { Name: 'config_2fa' }, Error: '' };
      if (method === 'config/update') return { State: '', Option: null };
      assert.equal(method, 'operations/list');
      assert.equal(body.fs, 'apple-photos:');
      if (!body.remote) return { list: [entry('', 'PrimarySync', true)] };
      if (body.remote === 'PrimarySync') return { list: [entry(body.remote, 'All Photos', true), entry(body.remote, 'Empty', true)] };
      if (body.remote.endsWith('/Empty')) return { list: [] };
      return { list: [entry(body.remote, 'café #1.jpg'), ...Array.from({ length: 100 }, (_, index) => entry(body.remote, `IMG_${index}.HEIC`))] };
    },
    async object(parts) {
      assert.deepEqual(parts, ['PrimarySync', 'All Photos', 'café #1.jpg']);
      return Object.assign(Readable.from([bytes], { objectMode: false }), { statusCode: 200, headers: { 'content-length': '4' } });
    },
    async close() { this.closed = true; },
  };
}

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
  const host = createFakePluginHost({ pluginId: 'photos', agentSkillIds: ['photos'] });
  const apple = mockApple(), grain = mockGrain();
  const temp = await mkdtemp('/tmp/photos-settings-test-');
  const grainStorage = grainSettingsFile(join(temp, 'grain'));
  await registerPhotos(host.bb, { apple, grainStorage, grainFetch: grain.fetcher });
  try {
    const { behavior } = host.harness;
    const post = async (path, json) => (await behavior.fetchHttp("POST", `/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json),
    })).json();
    const rpc = (name, input) => behavior.callRpc(name, input, caller);
    const download = ticket => behavior.fetchHttp("GET", `/apple-download?ticket=${ticket}`);
    await run({ host, apple, grain, grainStorage, post, rpc, download });
  } finally { await host.harness.lifecycle.dispose(); await rm(temp, { recursive: true, force: true }); assert.equal(apple.closed, true); }
}

test('Apple sign-in, nested albums, paging, selected download and safe failure diagnostics', async () => {
  await withHost(async ({ host, apple, post, rpc, download }) => {
    assert.deepEqual(await rpc('status', null), { apple: 'disconnected', grain: null });
    const start = await post('apple-connect', { account: 'apple@example.test', password: appleSecret });
    assert.equal(start.status.apple, 'verification');
    assert.equal((await post('apple-verify', { answer: '123456' })).status.apple, 'saved');
    assert.equal(apple.calls.find(call => call.method === 'config/create').body.parameters.service, 'photos');
    const libraries = await rpc('browse', { parent: null });
    const library = await rpc('browse', { parent: { listing: libraries.listing, index: 0 } });
    const album = await rpc('browse', { parent: { listing: library.listing, index: 0 } });
    assert.equal(album.total, 101);
    assert.equal(album.entries.length, 100);
    assert.equal((await rpc('page', { listing: album.listing, offset: 100 })).entries.length, 1);
    const parent = await rpc('browse', { parent: { listing: album.listing, index: null } });
    assert.equal(parent.entries[0].name, 'All Photos');
    const empty = await rpc('browse', { parent: { listing: parent.listing, index: 1 } });
    assert.equal(empty.total, 0);
    assert.equal((await rpc('download', { listing: parent.listing, index: 0, mode: 'download' })).ok, false);
    const input = { listing: album.listing, index: 0, mode: 'download' };
    await assert.rejects(host.harness.behavior.callRpc('download', input, { experimental_caller: { kind: 'plugin', pluginId: 'other' } }), /Photos settings/);
    const file = await rpc('download', input);
    const response = await download(file.ticket);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment.*caf%C3%A9%20%231.jpg$/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await download(file.ticket)).status, 404);
    const preview = await rpc('download', { ...input, mode: 'preview' });
    const image = await download(preview.ticket);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    await image.arrayBuffer();
    apple.fail = true;
    const failedRead = await rpc('browse', { parent: null });
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.equal(failedRead.ok, false);
    assert.match(logs, /Photos apple_browse unavailable/);
    assert.doesNotMatch(logs + JSON.stringify(failedRead), new RegExp(`${appleSecret}|${privateText}`));
    const newer = await rpc('download', input);
    assert.equal((await post('apple-disconnect', {})).status.apple, 'disconnected');
    assert.equal((await download(newer.ticket)).status, 404);
    assert.equal(apple.resets(), 2);
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

const native = process.platform === 'linux' && spawnSync('rclone', ['version'], { stdio: 'ignore' }).status === 0;
test('native rclone uses encrypted config, exclusive ownership and exact nested streaming', { skip: !native }, async () => {
  const temp = await mkdtemp('/tmp/photos-native-test-');
  const root = join(temp, 'state');
  const remote = rcloneRemote(root);
  const competing = rcloneRemote(root);
  const signal = AbortSignal.timeout(30_000);
  try {
    const fixture = join(temp, 'fixture');
    await mkdir(join(fixture, 'Album with spaces'), { recursive: true });
    await writeFile(join(fixture, 'Album with spaces', 'café #1.jpg'), bytes);
    await remote.resetAccount(signal);
    await remote.rpc('config/create', { name: 'apple-photos', type: 'alias', parameters: { remote: fixture }, opt: { nonInteractive: true } }, signal);
    assert.match(await readFile(join(root, 'rclone.conf'), 'utf8'), /^RCLONE_ENCRYPT_V0:$/m);
    await assert.rejects(competing.rpc('rc/noop', {}, signal), { category: 'busy' });
    const apple = applePhotos(remote, { get: async () => true, set: async () => {} });
    const library = await apple.browse(null);
    const album = await apple.browse({ listing: library.listing, index: 0 });
    const { ticket } = await apple.ticket(album.listing, 0, 'download');
    const { response } = await apple.download(ticket, signal);
    assert.deepEqual(Buffer.concat(await Array.fromAsync(response)), bytes);
    await apple.close();
    await competing.rpc('rc/noop', {}, signal);
  } finally {
    await remote.close();
    await competing.close();
    await rm(temp, { recursive: true, force: true });
  }
});
