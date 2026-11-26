import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

test('unoffered legacy selections fail closed during unavailable discovery rather than silently selecting a different vault', async () => {
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one', projectsFolder: 'Life/Projects' }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') throw new Error('sentinel-private-catalog');
    assert.equal(args.input.root, 'Life');
    assert.fail('Vault discovery failure must not try inventory');
  } } } });
  await plugin(host.bb);
  try {
    const result = JSON.parse((await host.harness.behavior.runCli(['projects', '--json'])).stdout!);
    assert.equal(result.error.code, 'unconfigured'); assert.equal(result.source, undefined);
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('vault selector offers discovered roots, scopes folders relative to the vault, and preserves source references', async () => {
  let present = true; const folders: string[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: present ? [{ id: 'one', root: 'Life', name: 'Life' }] : [], incomplete: false };
    if (args.method === 'vaultInventory') {
      if (!present) throw new Error('Unavailable authorized root');
      const source = { vaultId: 'one', name: 'Container', cloudConnected: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null };
      if (args.input.folders?.length === 0) return { source, notes: [], folders: [], incomplete: false };
      folders.push(args.input.root);
      return { source, notes: [{ path: 'Life/Projects/Launch.md', properties: { status: 'active' }, malformed: false }],
        folders: ['Life','Life/Projects','Life/Areas'], incomplete: false };
    }
    throw new Error('Unexpected method');
  } } } });
  await plugin(host.bb);
  try {
    await assert.rejects(host.harness.behavior.setSettings({ vaultId: 'unoffered' }));
    await host.harness.behavior.setSettings({ vaultId: 'one/Life', projectsFolder: 'Projects' });
    const result = JSON.parse((await host.harness.behavior.runCli(['projects', '--json'])).stdout!);
    assert.equal(result.source.name, 'Life'); assert.equal(result.source.scope, 'Projects');
    assert.deepEqual(folders, ['Life']);
    assert.equal(result.projects[0].id, 'Life/Projects/Launch.md');
    present = false;
    const missing = await host.harness.behavior.runCli(['projects', '--json']);
    assert.notEqual(missing.exitCode, 0); assert.match(missing.stdout!, /source_unavailable/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('the watch uses the configured scopes and redacts failed probe details', async () => {
  const revision = '12345678-1234-4123-8123-123456789abc:10';
  let available = true;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: {
    vaultId: 'one/Life', projectsFolder: 'Work/Projects', areasFolder: 'Areas',
  }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Life' }], incomplete: false };
    assert.equal(args.method, 'inventoryRevision');
    assert.deepEqual(args.input, { vaultId: 'one', folders: ['Life/Work/Projects', 'Life/Areas'] });
    if (!available) throw new Error('sentinel-private-watch-path');
    return revision;
  } } } });
  await plugin(host.bb);
  try {
    assert.equal(await host.harness.behavior.callRpc('inventoryRevision', null), revision);
    available = false;
    await assert.rejects(host.harness.behavior.callRpc('inventoryRevision', null), error => {
      assert.doesNotMatch(String(error), /sentinel/);
      return true;
    });
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /GTD watch/);
    assert.doesNotMatch(logs, /sentinel|Life/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('correspondence reads scoped landing-note links and routes saved URLs to both providers', async () => {
  const gmail = 'https://mail.google.com/mail/?authuser=person%40example.com#all/beef';
  const fastmail = 'https://app.fastmail.com/mail/Archive/S_anchor?u=1234abcd';
  const archivedMail = gmail.replace('beef', 'abba');
  const ref = { source: 'one', id: 'Life/Projects/Active/Launch.md' };
  let mailReads = 0;
  let noteChanged = false;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: {
    vaultId: 'one/Life', projectsFolder: 'Projects', areasFolder: 'Areas',
  }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Life' }], incomplete: false };
    if (args.method === 'readSectionLinks') {
      assert.equal(args.pluginId, 'obsidian');
      assert.equal(args.input.vaultId, 'one');
      assert.equal(args.input.path, ref.id);
      const lists = {
        'Active conversations': [{ title: 'Workshop', url: gmail }],
        'Archived conversations': [{ title: 'Earlier booking', url: archivedMail }, { title: 'Duplicate', url: gmail }],
        'Snoozed conversations': [],
        Correspondence: [{ title: 'Duplicate', url: gmail }, { title: 'Old booking', url: archivedMail }, { title: 'Venue', url: fastmail }],
      };
      const heading = args.input.heading as keyof typeof lists;
      assert.ok(Object.hasOwn(lists, heading));
      return { hash: (noteChanged && heading === 'Correspondence' ? 'b' : 'a').repeat(64), links: lists[heading], incomplete: false };
    }
    mailReads++;
    if (args.pluginId === 'google-workspace') {
      assert.equal(args.method, 'gmailConversationStatus');
      assert.deepEqual(args.input, { url: gmail });
      return { status: 'ok', unread: 2, sender: null, latestAt: null };
    }
    assert.equal(args.pluginId, 'fastmail');
    assert.equal(args.method, 'fastmailConversationStatus');
    assert.deepEqual(args.input, { url: fastmail });
    return { status: 'ok', unread: 3, sender: null, latestAt: null, threadKey: 'a'.repeat(64) };
  } } } });
  await plugin(host.bb);
  try {
    const rpc = host.harness.behavior.callRpc;
    await assert.rejects(rpc('readCorrespondence', { ...ref, id: 'Life/Areas/Workshop.md' }));
    assert.deepEqual(await rpc('readCorrespondence', ref), {
      active: { links: [{ title: 'Workshop', url: gmail }, { title: 'Venue', url: fastmail }], incomplete: false },
      archived: { links: [{ title: 'Earlier booking', url: archivedMail }], incomplete: false },
      snoozed: { links: [], incomplete: false },
    });
    assert.equal(mailReads, 0);
    assert.deepEqual(await rpc('readCorrespondenceStatus', ref), [
      { url: gmail, mail: { status: 'ok', unread: 2, sender: null, latestAt: null } },
      { url: fastmail, mail: { status: 'ok', unread: 3, sender: null, latestAt: null, threadKey: 'a'.repeat(64) } },
    ]);
    assert.equal(mailReads, 2);
    noteChanged = true;
    await assert.rejects(rpc('readCorrespondenceStatus', ref), /Could not read correspondence/);
    assert.equal(mailReads, 2);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('Area mail only reads the selected Area and status, including nested Area assignments', async () => {
  const note = (path: string, properties: Record<string, string> = {}) => ({ path, properties, malformed: false });
  const notes = [
    note('Areas/Learning.md'), note('Areas/Learning/Nested.md'), note('Areas/Home.md'),
    note('Projects/Active/Matches.md', { area: 'Areas/Learning/Nested.md' }),
    note('Projects/Active/Other.md', { area: 'Areas/Home.md' }),
    note('Projects/Done/Finished.md', { area: 'Areas/Learning.md' }),
    note('Projects/Active/Unassigned.md'),
  ];
  const paths: string[] = [];
  const fastmail = 'https://app.fastmail.com/mail/Archive/S_area?u=1234abcd';
  let incomplete = false;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one', projectsFolder: 'Projects', areasFolder: 'Areas' },
    sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Example' }], incomplete: false };
      if (args.method === 'vaultInventory') return {
        source: { vaultId: 'one', name: 'Example', lastSuccess: null, cloudConnected: false, enabled: false, phase: 'paused', failure: null },
        notes, folders: ['Projects', 'Areas'], incomplete,
      };
      if (args.pluginId === 'fastmail') {
        assert.equal(args.method, 'fastmailConversationStatus');
        assert.deepEqual(args.input, { url: fastmail });
        return { status: 'ok', unread: 1, sender: null, latestAt: null, threadKey: 'b'.repeat(64) };
      }
      assert.equal(args.method, 'readSectionLinks');
      paths.push(args.input.path);
      const active = args.input.path.endsWith('/Matches.md') && args.input.heading === 'Correspondence';
      const archived = args.input.path.endsWith('/Unassigned.md') && args.input.heading === 'Archived conversations';
      const snoozed = args.input.path.endsWith('/Unassigned.md') && args.input.heading === 'Snoozed conversations';
      const links = active || archived ? [{ title: 'Area mail', url: fastmail }] : snoozed
        ? [{ title: 'Snoozed mail', url: fastmail.replace('S_area', 'S_snoozed'), returnDate: '2026-12-01' }] : [];
      return { hash: 'a'.repeat(64), links, incomplete: false };
    } } } });
  await plugin(host.bb);
  try {
    const rpc = host.harness.behavior.callRpc;
    const area = { source: 'one', areaId: 'Areas/Learning.md', status: 'active' };
    const first = await Promise.all([rpc('readAreaMailStatus', area), rpc('readAreaMailStatus', area)]);
    for (const rows of first) assert.deepEqual(rows, [{ id: 'Projects/Active/Matches.md', state: 'unread' }]);
    assert.deepEqual(await rpc('readAreaMailStatus', { ...area, areaId: null }), [{ id: 'Projects/Active/Unassigned.md', state: 'clear' }]);
    await assert.rejects(rpc('readAreaMailStatus', { ...area, source: 'wrong' }));
    incomplete = true;
    assert.deepEqual(await rpc('readAreaMailStatus', area), []);
    assert.deepEqual(paths, [...Array(4).fill('Projects/Active/Matches.md'), ...Array(4).fill('Projects/Active/Unassigned.md')]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('agent correspondence tools page saved links, open exact URLs, and archive with checked receipts', async () => {
  const ref = { source: 'one', id: 'Projects/Active/Launch.md' };
  const url = 'https://mail.google.com/mail/?authuser=person%40example.com#all/beef';
  const workshop = { title: 'Workshop', url };
  const unsupported = { title: 'Lookalike', url: 'https://mail.google.com.example/mail/example' };
  let active = [workshop, unsupported, ...Array.from({ length: 9 }, (_, i) => ({ title: `Link ${i}`, url: url.replace('beef', `abc${i}`) }))];
  const archived: typeof active = [];
  let hash = 'a'.repeat(64);
  let loseReceipt = true;
  const operations: string[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one' }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Vault' }], incomplete: false };
    assert.equal(args.pluginId, 'obsidian');
    assert.equal(args.input.path, ref.id);
    if (args.method === 'readSectionLinks') return { hash, incomplete: false, links: args.input.heading === 'Active conversations' ? active
      : args.input.heading === 'Archived conversations' ? archived : [] };
    assert.equal(args.method, 'moveSectionLink');
    const { operationId } = args.input;
    assert.deepEqual(args.input, { vaultId: 'one', path: ref.id, from: ['Active conversations', 'Correspondence'], to: 'Archived conversations',
      url, expectedHash: hash, operationId });
    operations.push(operationId);
    if (loseReceipt) throw new Error('private sentinel ' + url);
    active = active.filter(link => link.url !== url);
    archived.push(workshop);
    hash = 'b'.repeat(64);
    return { operationId, outcome: 'saved_locally_pending_sync' };
  } } } });
  await plugin(host.bb);
  try {
    const run = async (name: string, input: unknown, isError?: true) => {
      const result = await host.harness.behavior.callAgentTool('gtd_' + name, input);
      assert.ok(typeof result !== 'string');
      assert.equal(result.isError, isError);
      const content = result.content[0];
      assert.equal(content?.type, 'text');
      return JSON.parse(content.text);
    };
    const page = await run('list_correspondence', ref);
    const [first, second] = page.conversations;
    assert.deepEqual({ title: first.title, status: first.status, provider: first.provider }, { title: 'Workshop', status: 'active', provider: 'gmail' });
    assert.equal(page.nextOffset, 10);
    const continuation = { ...ref, offset: page.nextOffset, version: page.version };
    assert.equal((await run('list_correspondence', continuation)).conversations.length, 1);
    assert.deepEqual(await run('open_correspondence', { ...ref, conversationId: first.conversationId }),
      { title: 'Workshop', href: url, status: 'active', provider: 'gmail' });
    assert.equal((await run('open_correspondence', { ...ref, conversationId: second.conversationId }, true)).code, 'unsupported');

    const operationId = '12345678-1234-4123-8123-123456789abc';
    const input = { ...ref, conversationId: first.conversationId, operationId };
    const uncertain = await run('archive_correspondence', input, true);
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.operationId, operationId);
    assert.deepEqual(operations, [operationId]);
    assert.doesNotMatch(JSON.stringify(uncertain) + JSON.stringify(host.harness.inspection.logEntries), /sentinel|person%40|Launch\.md/);

    loseReceipt = false;
    const confirmed = await run('archive_correspondence', { ...input, operationId: '12345678-1234-4123-8123-123456789def' });
    assert.equal(confirmed.state, 'archived');
    assert.equal(confirmed.outcome, 'saved_locally_pending_sync');
    assert.deepEqual(await run('archive_correspondence', input), { state: 'already_archived' });
    assert.equal(operations.length, 2);
    assert.equal((await run('list_correspondence', continuation, true)).code, 'changed');
    const filtered = await run('list_correspondence', { ...ref, status: 'archived' });
    assert.deepEqual(filtered.conversations, [{ ...first, status: 'archived' }]);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('adding correspondence verifies the provider and files an exact link once under the requested status', async () => {
  const ref = { source: 'one', id: 'Projects/Active/Launch.md' };
  const gmail = 'https://mail.google.com/mail/?authuser=person%40example.com#all/beef';
  const fastmail = 'https://app.fastmail.com/mail/Archive/S_anchor?u=1234abcd';
  const badAccount = gmail.replace('person', 'other');
  let hash = 'a'.repeat(64);
  const sections = new Map<string, { title: string; url: string }[]>();
  const verified: string[] = [];
  const writes: Array<{ heading: string; url: string }> = [];
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one' }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Vault' }], incomplete: false };
    if (args.method === 'gmailConversationStatus' || args.method === 'fastmailConversationStatus') {
      const { url } = args.input;
      assert.equal(args.pluginId, url === fastmail ? 'fastmail' : 'google-workspace');
      verified.push(url);
      return url === badAccount ? { status: 'account_missing' } : { status: 'ok', unread: 0, sender: null, latestAt: null };
    }
    assert.equal(args.pluginId, 'obsidian');
    assert.equal(args.input.vaultId, ref.source);
    assert.equal(args.input.path, ref.id);
    const { heading, title, url, operationId } = args.input;
    const links = sections.get(heading) ?? [];
    if (args.method === 'readSectionLinks') return { hash, links, incomplete: false };
    assert.equal(args.method, 'addSectionLink');
    assert.equal(args.input.expectedHash, hash);
    writes.push({ heading, url });
    sections.set(heading, [...links, { title, url }]);
    hash = (writes.length === 1 ? 'b' : 'c').repeat(64);
    return { operationId, outcome: 'saved_locally_pending_sync' };
  } } } });
  await plugin(host.bb);
  try {
    const add = async (url: string, index: number, status?: 'active' | 'archived', isError?: true) => {
      const operationId = `12345678-1234-4123-8123-123456789ab${index}`;
      const result = await host.harness.behavior.callAgentTool('gtd_add_correspondence', { ...ref, url, title: 'Re: [Launch] *plan*', status, operationId });
      assert.ok(typeof result !== 'string');
      assert.equal(result.isError, isError);
      const content = result.content[0];
      assert.equal(content?.type, 'text');
      return JSON.parse(content.text);
    };
    const rejected = await add(badAccount, 1, undefined, true);
    assert.equal(rejected.code, 'mail_unverified');
    assert.equal(rejected.mailStatus, 'account_missing');
    assert.equal((await add('https://mail.google.com.example/mail/Inbox/', 2, undefined, true)).code, 'unsupported');
    assert.equal(writes.length, 0);
    const active = await add(gmail, 3);
    assert.equal(active.state, 'added');
    assert.equal(active.status, 'active');
    assert.deepEqual(await add(gmail, 4, 'archived'), { state: 'already_linked', status: 'active', conversationId: active.conversationId });
    const archived = await add(fastmail, 5, 'archived');
    assert.equal(archived.state, 'added');
    assert.equal(archived.status, 'archived');
    assert.deepEqual(verified, [badAccount, gmail, fastmail]);
    assert.deepEqual(writes, [{ heading: 'Active conversations', url: gmail }, { heading: 'Archived conversations', url: fastmail }]);
    const listing = await host.harness.behavior.callRpc('readCorrespondence', ref);
    assert.deepEqual(listing, { active: { links: sections.get('Active conversations'), incomplete: false },
      archived: { links: sections.get('Archived conversations'), incomplete: false }, snoozed: { links: [], incomplete: false } });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('creating a project uses the exact selected Area and never retries an uncertain save', async () => {
  const folder = 'Life/Areas/Hands-on #50%/';
  const area = 'Life/Areas/Learning.md';
  const source = { vaultId: 'one', name: 'Example', lastSuccess: null, cloudConnected: false, enabled: false, phase: 'paused', failure: null };
  const notes = [{ path: area, properties: {}, malformed: false }];
  const writes: unknown[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one/Life' },
    sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Example' }], incomplete: false };
      if (args.method === 'vaultInventory') return { source, notes, folders: ['Life/Projects', 'Life/Areas', folder.slice(0, -1)], incomplete: false };
      assert.equal(args.method, 'createNote');
      writes.push(args.input);
      if (args.input.path.endsWith('/Uncertain.md')) throw new Error('private provider content');
      notes.push({ path: args.input.path, properties: { area: args.input.path.endsWith('/Café.md') ? folder : area }, malformed: false });
      return { operationId: args.input.operationId, outcome: 'saved_locally_pending_sync' };
    } } } });
  await plugin(host.bb);
  try {
    const rpc = host.harness.behavior.callRpc;
    const input = { source: 'one', id: folder, name: ' Café ', operationId: randomUUID() };
    const path = 'Life/Projects/Café.md';
    assert.deepEqual(await rpc('createProject', input), { state: 'created', id: path });
    assert.deepEqual(writes, [{ vaultId: 'one', path, operationId: input.operationId, text: `---\narea: ${JSON.stringify(folder)}\n---\n` }]);
    const browse = await rpc('browseInventory', { includeAreas: true }) as { projects: { projects: unknown[] } };
    assert.deepEqual(browse.projects.projects, [{ id: path, title: 'Café', status: 'active', areaId: folder }]);
    assert.deepEqual(await rpc('createProject', { ...input, id: area, operationId: randomUUID() }), { state: 'exists' });
    assert.deepEqual(await rpc('createProject', { ...input, id: 'Life/Areas/Missing.md' }), { state: 'blocked' });
    await assert.rejects(rpc('createProject', { ...input, name: '../outside' }));
    assert.equal(writes.length, 1);

    assert.deepEqual(await rpc('createProject', { ...input, id: area, name: 'Uncertain', operationId: randomUUID() }), { state: 'uncertain' });
    assert.equal(writes.length, 2);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /GTD project_create uncertain/);
    assert.doesNotMatch(logs, /private provider content|Life\/Areas/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('action conversion creates in the owning Area before removing the versioned action', async () => {
  const area = 'Areas/Learning.md';
  const project = 'Projects/Active/Workshop.md';
  const projectId = 'Projects/Pack workshop tools.md';
  const source = { vaultId: 'one', name: 'Example', lastSuccess: null, cloudConnected: false, enabled: false, phase: 'paused', failure: null };
  const version = 'a'.repeat(64);
  const action = 'Pack the [workshop tools](https://example.com/tools)';
  const original = `- [ ] ${action}\n- [x] Book the room\n`;
  for (const scenario of ['area', 'project', 'stale', 'concurrent_edit', 'exists', 'create_uncertain', 'remove_conflict', 'remove_uncertain', 'details', 'bad_name', 'agent_failed', 'undo_changed'] as const) {
    const kind = scenario === 'project' ? 'project' : 'area';
    const id = kind === 'project' ? project : area;
    const writes: string[] = [];
    const workerCalls: string[] = [];
    const worker = makeThreadResponse({ id: 'naming-worker', status: 'idle', visibility: 'hidden' });
    let reads = 0;
    let section = original;
    const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one' },
      sdk: {
        projects: { list: async () => [{ id: 'personal', kind: 'personal' }] as any },
        threads: {
          spawn: async args => {
            workerCalls.push('spawn');
            assert.equal(args.projectId, 'personal');
            assert.equal(args.visibility, 'hidden');
            assert.equal(args.pluginMetadata?.actionProjectNaming, true);
            assert.ok(args.prompt?.endsWith(JSON.stringify({ action })));
            return worker;
          },
          wait: async ({ threadId }) => ({ matched: true, threadId, thread: worker, target: { kind: 'status', status: 'idle' } }),
          output: async () => {
            workerCalls.push('output');
            if (scenario === 'agent_failed') throw new Error('private provider content');
            return { output: JSON.stringify({ name: scenario === 'bad_name' ? '../private provider content' : 'Pack the workshop tools' }) };
          },
          archive: async () => { workerCalls.push('archive'); return { ok: true }; },
          stop: async () => { workerCalls.push('stop'); return { ok: true }; },
        },
        plugins: { callRpc: async (args: any) => {
        if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Example' }], incomplete: false };
        if (args.method === 'vaultInventory') return { source, folders: ['Projects', 'Areas'], incomplete: false,
          notes: [{ path: area, properties: {}, malformed: false }, { path: project, properties: { area }, malformed: false },
            ...(scenario === 'exists' ? [{ path: projectId, properties: {}, malformed: false }] : [])] };
        if (args.method === 'readNoteSection') {
          assert.equal(args.input.path, id);
          reads++;
          return { text: scenario === 'details' ? '- [ ] Pack the tools\n  - Check the kit\n' : section,
            hash: scenario === 'stale' || (scenario === 'concurrent_edit' && reads === 3) || section !== original ? 'b'.repeat(64) : version };
        }
        writes.push(args.method);
        const { operationId } = args.input;
        if (args.method === 'createNote') {
          assert.equal(args.input.path, projectId);
          assert.equal(args.input.text, `---\narea: ${JSON.stringify(area)}\n---\n`);
          if (scenario === 'create_uncertain') throw new Error('private provider content');
        } else {
          assert.equal(args.method, 'writeNoteSection');
          assert.equal(args.input.path, id);
          const restoring = section !== original;
          assert.equal(args.input.expectedHash, restoring ? 'b'.repeat(64) : version);
          assert.equal(args.input.text, restoring ? original : '- [x] Book the room\n');
          if (scenario === 'remove_conflict') return { operationId, outcome: 'not_saved', reason: 'changed' };
          if (scenario === 'remove_uncertain') throw new Error('private provider content');
          section = scenario === 'undo_changed' ? '- [ ] An intervening edit' : restoring ? original : '- [x] Book the room';
        }
        return { operationId, outcome: 'saved_locally_pending_sync' };
      } } } });
    await plugin(host.bb);
    try {
      const rpc = host.harness.behavior.callRpc;
      const actionRef = { kind, source: 'one', id, line: 1, version };
      const suggestion = await rpc('suggestActionProjectName', actionRef);
      const nameUnavailable = scenario === 'bad_name' || scenario === 'agent_failed';
      assert.deepEqual(suggestion, scenario === 'stale' ? { state: 'changed' } : scenario === 'details' ? { state: 'has_details' }
        : nameUnavailable ? { state: 'name_unavailable' } : { state: 'suggested', name: 'Pack the workshop tools' });
      assert.deepEqual(writes, []);
      assert.deepEqual(workerCalls, scenario === 'details' || scenario === 'stale' ? [] : ['spawn', 'output', 'archive', 'stop']);
      if (nameUnavailable) {
        const logs = JSON.stringify(host.harness.inspection.logEntries);
        assert.match(logs, /GTD action_project_name unavailable/);
        assert.doesNotMatch(logs, /private provider content/);
        continue;
      }
      const result = await rpc('createProjectFromAction', {
        ...actionRef, name: 'Pack workshop tools', operationId: randomUUID(),
      }) as { state: string; id?: string; operationId?: string; undoToken?: string };
      const expected = {
        area: 'converted', project: 'converted', stale: 'changed', concurrent_edit: 'changed',
        exists: 'exists', create_uncertain: 'uncertain', remove_conflict: 'action_kept', remove_uncertain: 'removal_unconfirmed',
        details: 'has_details', undo_changed: 'converted',
      }[scenario];
      assert.equal(result.state, expected, scenario);
      if (['converted', 'action_kept', 'removal_unconfirmed'].includes(expected)) {
        assert.equal(result.id, projectId);
        assert.deepEqual(writes, ['createNote', 'writeNoteSection']);
      } else assert.deepEqual(writes, scenario === 'create_uncertain' ? ['createNote'] : []);
      if (expected === 'converted') {
        const undo = { undoToken: result.undoToken, operationId: randomUUID() };
        assert.deepEqual(await rpc('undoActionProjectRemoval', undo), { state: scenario === 'undo_changed' ? 'changed' : 'restored' });
        assert.deepEqual(await rpc('undoActionProjectRemoval', undo), { state: 'unavailable' });
        assert.equal(section, scenario === 'undo_changed' ? '- [ ] An intervening edit' : original);
        assert.deepEqual(writes, scenario === 'undo_changed' ? ['createNote', 'writeNoteSection']
          : ['createNote', 'writeNoteSection', 'writeNoteSection']);
      }
      const logs = JSON.stringify(host.harness.inspection.logEntries);
      if (scenario === 'create_uncertain') assert.match(logs, /GTD action_project_create uncertain/);
      if (scenario === 'remove_uncertain') {
        assert.match(result.operationId ?? '', /^[\da-f-]{36}$/);
        assert.match(logs, /GTD action_project_remove uncertain/);
      }
      assert.doesNotMatch(logs, /private provider content|Pack the tools/);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});

test('snooze and refresh share agent and UI rules and persist both wake conditions', async () => {
  const ref = { source: 'one', id: 'Projects/Active/Launch.md' };
  const url = 'https://mail.google.com/mail/?authuser=example%40example.com#all/beef';
  const dueUrl = url.replace('beef', 'face');
  const workshop = { title: 'Workshop', url };
  const due = { title: 'Follow-up', url: dueUrl, returnDate: '2026-11-26' };
  const active = 'Active conversations', snoozed = 'Snoozed conversations';
  const sections = new Map<string, (typeof workshop & { returnDate?: string })[]>([[active, [workshop]], [snoozed, [due]]]);
  let hash = 'a'.repeat(64);
  let now = Date.parse('2026-11-26T06:59:59Z'); // Still November 25 in Vancouver.
  let unread = 1, mailReads = 0, saves = 0, loseReceipt = false;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one' }, sdk: { plugins: {
    callRpc: async (args: any) => {
      if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Vault' }], incomplete: false };
      if (args.method === 'gmailConversationStatus') {
        mailReads++;
        return args.input.url === dueUrl || unread < 0 ? { status: 'unavailable' }
          : { status: 'ok', unread, sender: null, latestAt: null };
      }
      assert.equal(args.pluginId, 'obsidian');
      assert.equal(args.input.path, ref.id);
      if (args.method === 'readSectionLinks') {
        assert.equal(!!args.input.dated, args.input.heading === snoozed);
        return { hash, incomplete: false, links: sections.get(args.input.heading) ?? [] };
      }
      assert.equal(args.method, 'editDatedSectionLinks');
      const { from, to, urls, returnDate, expectedHash, operationId } = args.input;
      assert.equal(expectedHash, hash);
      if (loseReceipt) throw new Error('private sentinel ' + url);
      for (const heading of from) sections.set(heading, (sections.get(heading) ?? []).filter(link => !urls.includes(link.url)));
      const moved = [workshop, due].filter(link => urls.includes(link.url))
        .map(({ title, url }) => ({ title, url, ...(returnDate && { returnDate }) }));
      sections.set(to, [...(sections.get(to) ?? []), ...moved]);
      saves++;
      hash = saves.toString(16).padStart(64, '0');
      return { operationId, outcome: 'saved_locally_pending_sync' };
    },
  } } });
  await plugin(host.bb, undefined, () => now);
  try {
    const rpc = host.harness.behavior.callRpc;
    const agent = async (name: string, input: unknown) => {
      const result = await host.harness.behavior.callAgentTool('gtd_' + name, input);
      assert.ok(typeof result !== 'string' && result.content[0]?.type === 'text');
      return JSON.parse(result.content[0].text);
    };
    const { conversations: [row] } = await agent('list_correspondence', { ...ref, status: 'active' });
    const target = { ...ref, conversationId: row.conversationId };
    const snooze = (returnDate: string) => agent('snooze_correspondence', { ...target, returnDate, operationId: randomUUID() });
    assert.equal(mailReads, 0);
    assert.deepEqual(await snooze('2026-11-25'), { state: 'blocked', reason: 'date_due' });
    assert.deepEqual(await snooze('2026-11-27'), { state: 'blocked', reason: 'unread' });
    unread = -1;
    assert.deepEqual(await snooze('2026-11-27'), { state: 'blocked', reason: 'mail_unavailable' });
    assert.equal(saves, 0);
    unread = 0;
    assert.equal((await snooze('2026-11-27')).state, 'snoozed');
    const beforeList = mailReads;
    const listed = await agent('list_correspondence', { ...ref, status: 'snoozed' });
    assert.deepEqual(listed.conversations.map((item: { returnDate: string }) => item.returnDate), ['2026-11-26', '2026-11-27']);
    assert.equal(mailReads, beforeList);
    assert.equal((await rpc('changeCorrespondenceSnooze', { ...ref, url, operationId: randomUUID(),
      change: { kind: 'snooze', returnDate: '2026-11-29' } }) as { state: string }).state, 'snoozed');
    const beforeMidnight = await agent('refresh_correspondence', ref);
    assert.deepEqual(beforeMidnight.returned, []);
    assert.equal(beforeMidnight.snoozedMailIncomplete, true);
    assert.deepEqual(beforeMidnight.active, []);
    now += 1000;
    unread = 2;
    loseReceipt = true;
    const uncertain = await agent('refresh_correspondence', ref);
    assert.equal(uncertain.receipt.outcome, 'uncertain');
    assert.deepEqual(uncertain.returned, []);
    assert.match(uncertain.nextAction, /receipt/);
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel|example%40|Launch\.md/);
    loseReceipt = false;
    const refreshed = await rpc('refreshCorrespondence', ref) as { returned: { reason: string }[]; mail: { mail: { unread?: number } }[] };
    assert.deepEqual(refreshed.returned.map(row => row.reason), ['date', 'unread']);
    assert.deepEqual(refreshed.mail.map(row => row.mail.unread), [undefined, 2]);
    assert.equal(saves, 3);
    unread = 0;
    assert.deepEqual((await agent('refresh_correspondence', ref)).returned, []);
    assert.equal((await snooze('2026-11-29')).state, 'snoozed');
    assert.equal((await agent('unsnooze_correspondence', { ...target, operationId: randomUUID() })).state, 'unsnoozed');
    assert.equal((await agent('list_correspondence', { ...ref, status: 'snoozed' })).conversations.length, 0);
  } finally { await host.harness.lifecycle.dispose(); }
});
