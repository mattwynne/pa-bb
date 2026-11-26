// Actual disposable BB host + built GTD app; all account/thread writes are synthetic.
// Set BB_REVIEW_APP_ROOT to the installed bb-app package, BB_REVIEW_CHROME to Chrome.
import { chromium } from 'playwright';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdtemp, mkdir, readFile, rename, symlink, unlink, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
const exec = promisify(execFile);
const bb = process.env.BB_REVIEW_APP_ROOT; assert.ok(bb);
const chrome = process.env.BB_REVIEW_CHROME; assert.ok(chrome);
const port = Number(process.env.BB_REVIEW_PORT ?? 42998);
for (const p of [port, port + 1]) await new Promise((ok, fail) => { const server = createServer(); server.once('error', fail); server.listen(p, '127.0.0.1', () => server.close(ok)); });
const root = await mkdtemp(join(tmpdir(), 'gtd-bb-review-'));
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? await mkdtemp(join(tmpdir(), 'gtd-review-evidence-'));
await mkdir(join(root, 'home')); await mkdir(artifacts, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: base, BB_HOST_DAEMON_PORT: String(port + 1) };
const native = process.env.BB_REVIEW_MODE === 'native-refresh';
const vault = join(root, 'synthetic-vault');
if (native) {
  assert.ok(process.env.PA_OBSIDIAN_TEST_DESKTOP && process.env.PA_OBSIDIAN_TEST_CLI);
  env.PA_OBSIDIAN_DESKTOP = process.env.PA_OBSIDIAN_TEST_DESKTOP;
  env.PA_OBSIDIAN_CLI = process.env.PA_OBSIDIAN_TEST_CLI;
  env.PA_OBSIDIAN_DESKTOP_VAULT_ID = 'one';
}
const fd = openSync(join(root, 'server.log'), 'w', 0o600);
const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] }); closeSync(fd);
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 120000 })).stdout;
let browser;
const ref = { source: 'one', id: 'Projects/Learn woodworking.md' };
const source = { backend: 'obsidian', id: 'one', name: 'Synthetic vault', obsidian: { vault: 'Synthetic vault', root: '' }, scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null };
const projectNote = legacyTitle => `---\ntitle: ${legacyTitle}\narea: Areas/Learning.md\n---\n`;
async function connectSyntheticVault(pkg) {
  for (const directory of ['.obsidian', 'Projects/Done', 'Projects/Someday', 'Areas', 'Elsewhere']) await mkdir(join(vault, directory), { recursive: true });
  await writeFile(join(vault, '.obsidian/app.json'), '{"alwaysUpdateLinks":true}');
  await writeFile(join(vault, 'Areas/Learning.md'), '# Learning\n\n## Standard\n\nPractice weekly.\n');
  await writeFile(join(vault, ref.id), projectNote('Legacy label'));
  const fixture = join(root, 'mirror-fixture');
  await mkdir(fixture);
  await symlink(join(pkg, 'node_modules'), join(fixture, 'node_modules'));
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'bb-plugin-icloud', version: '0.0.1', type: 'module',
    engines: { node: '>=22', bb: '>=0.50', bbPluginSdk: '>=0.6.157 <1' },
    bb: { name: 'Synthetic mirror', description: 'Grants local access to the disposable fixture vault.',
      branding: { icon: 'Cloud' }, server: './server.js' },
  }));
  const stat = await lstat(vault, { bigint: true });
  const directory = { directory: vault };
  const replies = {
    status: { noteAccessVersion: 2, mirrorAccessVersion: 3, available: true, connected: false, challenge: null, mirrors: [{
      id: 'one', folder: { name: 'Synthetic vault' }, initialized: true, enabled: false, phase: 'paused', lastSuccess: null, failure: null, filesystem: 'ready',
      local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null },
    }] },
    mirrorDirectoryGrant: { ...directory, rootDev: String(stat.dev), rootIno: String(stat.ino) }, mirrorDirectory: directory,
    noteReceipts: { ok: true, value: [] },
    noteMoveReceipts: { ok: true, value: [] },
  };
  await writeFile(join(fixture, 'server.js'), `
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function (bb) {
  const replies = ${JSON.stringify(replies)};
  const handlers = { ...Object.fromEntries(Object.keys(replies).map(name => [name, () => replies[name]])),
    noteConfigure: input => ({ ok: true, value: { revision: input.revision } }) };
  const contract = defineRpcContract(Object.fromEntries(Object.keys(handlers).map(name => [name, { input: z.unknown(), output: z.unknown() }])));
  bb.rpc.register(contract, handlers);
}`);
  await cli('plugin', 'install', fixture, '--yes', '--json');
  const input = join(root, 'connect.json');
  await writeFile(input, '{"vaultId":"one"}');
  await cli('plugin', 'rpc', 'call', 'obsidian', 'connect', '--input-file', input, '--json');
  await cli('plugin', 'reload', 'gtd', '--json');
  await cli('plugin', 'config', 'gtd', 'set', 'vaultId', 'one');
  const inventory = JSON.parse(await cli('gtd', 'projects', '--status', 'active', '--json'));
  assert.equal(inventory.coverage, 'complete');
  assert.deepEqual(inventory.projects.map(({ id, status }) => ({ id, status })), [{ id: ref.id, status: 'active' }]);
}
try {
  let ready = false; for (let i = 0; i < 100; i++) { assert.equal(server.exitCode, null); try { ready = (await fetch(base)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); } assert.ok(ready);
  const pkg = resolve(fileURLToPath(new URL('../', import.meta.url)));
  await cli('plugin', 'install', pkg, '--yes', '--json');
  await cli('plugin', 'install', resolve(pkg, '../obsidian'), '--yes', '--json');
  const statusRead = JSON.parse(await cli('plugin', 'rpc', 'call', 'obsidian', 'status', '--json'));
  const state = statusRead.result ?? statusRead;
  assert.deepEqual(state.vaults, []);
  const refusedInput = join(root, 'title-probe.json');
  await writeFile(refusedInput, JSON.stringify({ vaultId: 'one', path: 'Projects/Woodworking.md', expectedHash: '0'.repeat(64), set: {title: 'Synthetic'} }), { mode: 0o600 });
  let refused = false;
  try { await cli('plugin', 'rpc', 'call', 'obsidian', 'writeProperties', '--input-file', refusedInput, '--json'); } catch (error) { refused = /forbidden/.test(error.stdout ?? ''); }
  assert.ok(refused, 'Checked property bridge must refuse ordinary clients before note access');
  await writeFile(refusedInput, JSON.stringify({ vaultId: 'one', path: 'Projects/Woodworking.md',
    operationId: '12345678-1234-4123-8123-123456789abc', text: '# Synthetic' }), { mode: 0o600 });
  await assert.rejects(cli('plugin', 'rpc', 'call', 'obsidian', 'createNote', '--input-file', refusedInput, '--json'),
    error => /forbidden/.test(error.stdout ?? ''));
  let unconfigured = false;
  try { await cli('gtd', 'projects', '--json'); } catch (error) { unconfigured = /unconfigured/.test(error.stdout ?? ''); }
  assert.ok(unconfigured, 'Harmless GTD read must fail honestly before vault selection');
  assert.match(await cli('plugin', 'logs', 'gtd', '-n', '5'), /GTD list unconfigured/);
  console.log('Runtime checks: Obsidian status and property-write caller refusal, GTD unconfigured guard and bounded diagnostic verified.');
  if (native) await connectSyntheticVault(pkg);
  // The disposable host has no coding agent to complete first-run onboarding.
  await cli('settings', 'general', 'onboardingCompletedAt', new Date().toISOString());
  const setPreference = (key, value) => cli('settings', 'ui', 'set', key, value);
  await setPreference('sidebar.chronologicalSort', 'updated');
  await setPreference('sidebar.sortDirection', 'ascending');
  console.log(`Evidence: ${artifacts}`);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const modes = ['browser-flow', 'normal', 'empty', 'error', 'loading', 'missing', 'malformed', 'area-boundary', 'relationships', 'project-actions', 'create-project', 'area-standard', 'area-actions', 'section-filters', 'auto-refresh', 'project-actions-list', 'correspondence', 'area-mail', 'composer-project'];
  const selectedModes = process.env.BB_REVIEW_MODE?.split(',');
  const reviewedModes = native ? ['native-refresh'] : selectedModes ? modes.filter(mode => selectedModes.includes(mode)) : modes;
  assert.ok(reviewedModes.length, 'Unknown BB_REVIEW_MODE');
  for (const width of [1280, 390]) for (const mode of reviewedModes) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    page.setDefaultTimeout(12000);
    const errors = []; const consoleErrors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    let title = 'Learn woodworking', creations = 0;
    let watchRevision = null, inventoryReads = 0, heldRead, failInventory = false;
    let extraProject = null;
    const publish = revision => { watchRevision = `12345678-1234-4123-8123-123456789abc:${revision}`; };
    const projectChanges = [], areaCreations = [];
    const actionCreations = [];
    const projectCreations = [];
    const gmail = 'https://mail.google.com/mail/?authuser=example%40example.com#all/beef';
    const fastmail = 'https://app.fastmail.com/mail/Archive/S_anchor?u=1234abcd';
    const fastmailReply = 'https://app.fastmail.com/mail/Sent/T_one.S_reply?u=1234abcd';
    const fastmailOther = 'https://app.fastmail.com/mail/Archive/S_other?u=1234abcd';
    const fastmailUnresolved = 'https://app.fastmail.com/mail/Archive/S_missing?u=1234abcd';
    const archivedMail = 'https://mail.google.com/mail/?authuser=example%40example.com#all/abba';
    let heldCorrespondence, heldStatus, correspondenceReads = 0;
    let workshopReturnDate;
    const snoozeDate = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    let workshopArchived = false;
    let unread = 2, areaUnread = true;
    let assignedArea = 'Areas/Learning.md', projectStatus = 'active', projectId = ref.id;
    const standardSaves = [];
    let standardText = 'Practice weekly.', standardHash = 'a'.repeat(64);
    const standardReads = [];
    let homeStandard = '', firstHomeRead = true;
    let actionState = 'loading', releaseActions;
    let actionVersion = 'a'.repeat(64);
    let areaActions = [
      { line: 1, text: 'Bring the [workshop plan](https://example.com/plan)', complete: false },
      { line: 2, text: 'Book the room', complete: true },
      { line: 3, text: 'Pack the tools', complete: false },
    ];
    let refuseAction = false, failProjectActions = false, releaseProjectName;
    let conversionRequests = 0, removedAction;
    const conversionUndo = 'd4b5ed18-7bf0-42f4-9983-e6f06e9ac119';
    const associations = new Map(['fixture1', 'fixture2'].map(id => [id, mode === 'missing' ? { ...ref, id: 'Projects/Deleted.md' } : ref]));
    const thread = (id, projectId, title, updatedAt, archivedAt = null) => ({
      ...makeThreadResponse({ id, projectId, title, updatedAt, archivedAt, createdAt: 1,
        ...(mode === 'composer-project' && id === 'fixture2' ? { parentThreadId: 'fixture1' } : {}) }),
      activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
      queuedWork: 'none',
      hasPendingInteraction: false,
      pinSortKey: null,
      environmentHostId: null,
      environmentName: null,
      environmentBranchName: null,
      environmentPath: null,
      environmentProviderId: null,
      environmentIsWorktree: null,
      environmentWorkspaceDisplayKind: 'other',
    });
    await page.route('**/api/v1/sidebar-bootstrap', async route => {
      const response = await route.fetch(); const value = await response.json();
      value.personalProject.threads = [
        thread('fixture2', value.personalProject.id, 'Practice joints', 200),
        thread('fixture1', value.personalProject.id, 'Choose tools', 100),
      ];
      if (mode === 'browser-flow') value.personalProject.threads.push(thread('area1', value.personalProject.id, 'Practice plan', 100));
      if (mode === 'composer-project') value.personalProject.threads.push(thread('unlinked', value.personalProject.id, 'Unlinked thread', 100));
      await route.fulfill({ response, json: value });
    });
    await page.route(/\/api\/v1\/threads\?.*archived=true/, route => {
      const params = new URL(route.request().url()).searchParams;
      if (Number(params.get('offset')) > 0) return route.fulfill({ json: [thread('fixture4', 'proj_personal', 'Earlier rehearsal', 10, 20)] });
      const archived = [thread('fixture3', 'proj_personal', 'Archived rehearsal', 300, 400)];
      if (mode === 'browser-flow') archived.push(thread('area2', 'proj_personal', 'Past practice plan', 100, 200));
      if (mode === 'browser-flow') for (let i = archived.length; i < Number(params.get('limit')); i++) {
        archived.push(thread(`old${i}`, 'proj_personal', `Unlinked archived ${i}`, 30, 40));
      }
      return route.fulfill({ json: archived });
    });
    await page.route(/\/api\/v1\/threads\/fixture1(?:\?|$)/, route =>
      route.fulfill({ json: thread('fixture1', 'proj_personal', 'Choose tools', 100) }));
    if (mode === 'composer-project') {
      await page.route(/\/api\/v1\/threads\/fixture2(?:\?|$)/, route =>
        route.fulfill({ json: thread('fixture2', 'proj_personal', 'Practice joints', 200) }));
      await page.route(/\/api\/v1\/threads\/unlinked(?:\?|$)/, route =>
        route.fulfill({ json: thread('unlinked', 'proj_personal', 'Unlinked thread', 100) }));
    }
    await page.route(/\/api\/v1\/threads\/(?:fixture1|fixture2|unlinked)\/timeline(?:\?|$)/, route =>
      route.fulfill({ json: {
        rows: [], maxSeq: 0, contextBoundarySeq: null, completedTurnDisplay: 'collapse',
        activePromptMode: null, activeThinking: null, activeWorkflows: [], activeBackgroundCommands: [],
        pendingTodos: null, goal: null, providerCommands: null, sessionOptions: null, modelFallback: null,
        timelinePage: { returnedSegmentCount: 0, olderCursor: null, historySnapshot: 'fixture', olderRowsSourceSeqEnd: null },
      } }));
    associations.set('fixture3', ref);
    associations.set('fixture4', ref);
    await page.route('**/api/v1/threads/plugin-metadata', route => route.fulfill({
      json: { threads: route.request().postDataJSON().threadIds.map(threadId => ({
        threadId, metadata: ['area1', 'area2'].includes(threadId) ? { area: { source: 'one', id: 'Areas/Learning.md' } }
          : associations.has(threadId) ? { project: associations.get(threadId) } : {},
      })) },
    }));
    await page.route('**/api/v1/plugins/gtd/rpc/**', async route => {
      if (native) return route.continue();
      const method = new URL(route.request().url()).pathname.split('/').at(-1), input = route.request().postDataJSON();
      if (method === 'inventoryRevision') return route.fulfill({ json: { ok: true, result: watchRevision } });
      if (mode === 'loading') { await new Promise(r => setTimeout(r, 15000)); if (page.isClosed()) return; }
      if (mode === 'error') return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic failure' } } });
      let result;
      if (method === 'browseInventory') {
        inventoryReads++;
        await heldRead;
        if (failInventory) return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic failure' } } });
        const projects = mode === 'empty' ? [] : [{ id: projectId, title, status: projectStatus, areaId: assignedArea }];
        if (extraProject) projects.push(extraProject);
        if (mode === 'area-mail') projects.push(
          { id: 'Projects/Unknown.md', title: 'Unknown mail', status: 'active', areaId: assignedArea },
          { id: 'Projects/Clear.md', title: 'Read mail', status: 'active', areaId: assignedArea },
          { id: 'Projects/Skipped.md', title: 'Skipped check', status: 'active', areaId: assignedArea },
        );
        const areas = [{ id: 'Areas/Learning.md', title: 'Learning' }];
        if (mode === 'empty') areas.length = 0;
        if (mode === 'project-actions' || mode === 'browser-flow') areas.push({ id: 'Areas/Home.md', title: 'Home' });
        if (mode === 'area-standard' || mode === 'area-actions') areas.push({ id: 'Areas/Home.md', title: 'Home' }, { id: 'Areas/Folder/', title: 'Folder' });
        if (mode === 'create-project') areas.push({ id: 'Areas/Folder/', title: 'Folder' });
        if (mode === 'browser-flow') {
          areas.push({ id: 'Areas/Empty #50% 木/', title: 'Empty Area' });
          projects.push(
            { id: 'Projects/Someday/Bench.md', title: 'Build a bench', status: 'someday', areaId: assignedArea },
            { id: 'Projects/Done/Hammer.md', title: 'Find a hammer', status: 'done', areaId: 'Areas/Home.md' },
            { id: 'Projects/Deferred/Plane.md', title: 'Restore a plane', status: 'deferred', areaId: assignedArea },
          );
        }
        if (mode === 'area-boundary') {
          projects[0].areaId = 'Areas/Learning/Example Committee/Meeting.md';
          areas.push(...Array.from({ length: 8 }, (_, i) => ({ id: `Areas/Empty${i}/`, title: `Empty Area ${i}` })));
        }
        if (mode === 'relationships') {
          projects[0].areaId = 'Areas/Learning/Consulting.md';
          projects.push({ id: 'Projects/Unresolved.md', title: 'Unresolved project', status: 'active' });
        }
        const complete = mode !== 'malformed';
        result = {
          projects: { source, projects, complete, warnings: complete ? [] : ['invalid_project'],
            ...(!complete ? { malformedFrontmatter: ['Projects/Broken.md'] } : {}) },
          areas: (input.input ?? input).includeAreas ? { source, areas, complete: true, warnings: [] } : null,
        };
      }
      if (method === 'readAreaMailStatus') {
        assert.equal(input.source, 'one');
        result = mode === 'area-mail' && input.areaId === 'Areas/Learning.md' && input.status === 'active' ? [
          { id: projectId, state: areaUnread ? 'unread' : 'clear' },
          { id: 'Projects/Unknown.md', state: 'incomplete' },
          { id: 'Projects/Clear.md', state: 'clear' },
        ] : [];
      }
      if (method === 'createProject') {
        projectCreations.push(input);
        if (input.name === 'Uncertain') result = { state: 'uncertain' };
        else if (input.name === 'Existing') result = { state: 'exists' };
        else {
          extraProject = { id: `Projects/${input.name}.md`, title: input.name, status: 'active', areaId: input.id };
          result = { state: 'created', id: extraProject.id };
        }
      }
      if (method === 'suggestActionProjectName' || method === 'createProjectFromAction') {
        assert.equal(input.kind, 'area');
        assert.equal(input.id, assignedArea);
        assert.equal(input.version, actionVersion);
        const action = areaActions.find(action => action.line === input.line);
        assert.equal(action?.text, 'Prepare the [workshop](https://example.com/workshop)');
        if (method === 'suggestActionProjectName') {
          if (refuseAction) {
            await new Promise(resolve => { releaseProjectName = resolve; });
            result = { state: 'name_unavailable' };
          } else result = { state: 'suggested', name: 'Prepare the workshop' };
        } else {
          ++conversionRequests;
          assert.equal(input.name, 'Organize the workshop');
          removedAction = action;
          extraProject = { id: 'Projects/Organize the workshop.md', title: input.name, status: 'active', areaId: input.id };
          areaActions = areaActions.filter(item => item.line !== input.line);
          result = { state: 'converted', id: extraProject.id, undoToken: conversionUndo };
        }
      }
      if (method === 'undoActionProjectRemoval') {
        assert.equal(input.undoToken, conversionUndo);
        assert.ok(removedAction);
        areaActions.unshift(removedAction);
        result = { state: 'restored' };
      }
      if (method === 'readNoteActions') {
        if ((mode === 'area-actions' && input.kind === 'area') || (mode === 'project-actions-list' && input.kind === 'project')) {
          if (input.id === 'Areas/Folder/') throw new Error('Folder-only Area requested an action read');
          if (input.id === 'Areas/Home.md' || failProjectActions) return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic read failure' } } });
          if (actionState === 'loading') await new Promise(resolve => { releaseActions = resolve; });
          if (actionState === 'ready') result = { version: actionVersion, actions: areaActions };
        }
        result ??= { version: actionVersion, actions: [] };
      }
      if (method === 'changeNoteAction') {
        const projectActions = mode === 'project-actions-list';
        assert.equal(input.kind, projectActions ? 'project' : 'area');
        assert.equal(input.id, projectActions ? projectId : 'Areas/Learning.md');
        if (refuseAction) result = { outcome: 'not_saved', reason: 'changed' };
        else {
          const { change } = input;
          if (change.operation === 'undoCompletion') {
            if (change.sectionVersion !== actionVersion)
              return route.fulfill({ json: { ok: true, result: { outcome: 'not_saved', reason: 'changed' } } });
            areaActions = areaActions.map(action => action.line === change.line ? { ...action, complete: false } : action);
          } else if (change.operation === 'edit') {
            assert.equal(change.version, actionVersion);
            areaActions = areaActions.map(action => action.line === change.line ? {
              ...action, complete: change.complete ?? action.complete, text: change.text ?? action.text,
            } : action);
          } else {
            areaActions = [{ line: 1, text: change.text, complete: false },
              ...areaActions.map(action => ({ ...action, line: action.line + 2 }))];
          }
          actionVersion = actionVersion === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
          result = { outcome: 'saved_locally_pending_sync',
            ...(change.operation === 'edit' && change.complete === true ? { completionVersion: actionVersion } : {}) };
        }
      }
      if (method === 'readCorrespondence' || method === 'refreshCorrespondence') {
        if (method === 'readCorrespondence') {
          correspondenceReads++;
          await heldCorrespondence;
        } else await heldStatus;
        const workshop = { title: 'Workshop logistics', url: gmail };
        const returned = method === 'refreshCorrespondence' && workshopReturnDate && unread > 0
          ? [{ ...workshop, reason: 'unread' }] : [];
        if (returned.length) workshopReturnDate = undefined;
        const correspondence = {
          active: { incomplete: false, links: mode === 'correspondence' ? [
            ...(workshopArchived || workshopReturnDate ? [] : [workshop]),
            { title: 'Venue booking', url: fastmail },
            { title: 'Venue reply', url: fastmailReply },
            { title: 'Supplies', url: fastmailOther },
            { title: 'Unresolved venue message', url: fastmailUnresolved },
            { title: 'Lookalike', url: 'https://mail.google.com.example/mail/example' },
          ] : [] },
          archived: { incomplete: false, links: mode === 'correspondence' ? [
            { title: 'Previous booking', url: archivedMail }, ...(workshopArchived ? [workshop] : []),
          ] : [] },
          snoozed: { incomplete: false, links: workshopReturnDate ? [{ ...workshop, returnDate: workshopReturnDate }] : [] },
        };
        const known = { status: 'ok', sender: 'Test Sender', latestAt: '2026-11-25T12:00:00.000Z' };
        const mail = [
          ...(workshopArchived || workshopReturnDate ? [] : [{ url: gmail, mail: unread < 0 ? { status: 'unavailable' } : { ...known, unread } }]),
          { url: fastmail, mail: { ...known, unread: 3, threadKey: 'a'.repeat(64) } },
          { url: fastmailReply, mail: { ...known, unread: 3, threadKey: 'a'.repeat(64) } },
          { url: fastmailOther, mail: { ...known, unread: 1, threadKey: 'b'.repeat(64) } },
          { url: fastmailUnresolved, mail: { status: 'not_found' } },
        ];
        result = method === 'readCorrespondence' ? correspondence : { correspondence, mail, returned, snoozedMailIncomplete: false };
      }
      if (method === 'changeCorrespondenceSnooze') {
        assert.equal(input.url, gmail);
        if (input.change.kind === 'snooze' && unread > 0) result = { state: 'blocked', reason: 'unread' };
        else {
          workshopReturnDate = input.change.returnDate;
          result = { state: workshopReturnDate ? 'snoozed' : 'unsnoozed',
            receipt: { operationId: input.operationId, outcome: 'saved_locally_pending_sync' } };
        }
      }
      if (method === 'readAreaStandard') {
        standardReads.push(input.id);
        if (input.id === 'Areas/Home.md' && firstHomeRead) {
          firstHomeRead = false;
          return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic read failure' } } });
        }
        result = { text: input.id === 'Areas/Learning.md' ? standardText : homeStandard, hash: standardHash };
      }
      if (method === 'saveAreaStandard') {
        standardSaves.push(input);
        result = { operationId: input.operationId, outcome: 'saved_locally_pending_sync' };
        if (input.text === 'Conflicting draft') {
          standardText = 'Edit made in Obsidian.';
          standardHash = 'c'.repeat(64);
          result = { ...result, outcome: 'not_saved', reason: 'changed' };
        } else if (input.text === 'Unconfirmed draft') {
          result = { ...result, outcome: 'uncertain' };
        } else if (input.id === 'Areas/Home.md') {
          homeStandard = input.text;
        } else {
          standardText = input.text;
          standardHash = 'b'.repeat(64);
        }
      }
      if (method === 'newThread') { creations++; await new Promise(r => setTimeout(r, 250)); result = { threadId: 'fixture1' }; }
      if (method === 'newAreaThread') { areaCreations.push(input); result = { threadId: 'fixture1' }; }
      if (method === 'startActionThread') {
        actionCreations.push(input);
        result = actionCreations.length === 1 ? { changed: true } : { threadId: 'fixture1' };
      }
      if (method === 'changeProject') {
        projectChanges.push(input.change);
        if (input.change.kind === 'area') {
          assignedArea = input.change.areaPath;
          result = { state: 'assigned', message: 'Project assigned locally. iCloud sync is pending.' };
        } else if (input.change.kind === 'rename') {
          title = input.change.name;
          projectId = `${projectId.slice(0, projectId.lastIndexOf('/'))}/${title}.md`;
          result = { state: 'renamed', id: projectId, message: 'Project renamed in Obsidian.' };
        } else {
          projectStatus = 'done';
          projectId = 'Projects/Done/Learn woodworking.md';
          result = { state: 'done', message: 'Project moved to Done locally and all linked threads archived.' };
        }
      }
      if (method === 'associate') { if (input.project) associations.set(input.threadId, input.project); else associations.delete(input.threadId); result = null; }
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.goto(base);
    const skip = page.getByRole('button', { name: 'Skip setup', exact: true });
    const entry = page.getByRole('button', { name: /^GTD(?: \(.*\))?$/ });
    const toggle = page.getByRole('button', { name: /Show sidebar|Open sidebar|Toggle sidebar/i }).first();
    const openSidebar = async () => {
      if (width === 390) {
        const open = page.locator('main[data-sidebar-shelf="open"]');
        if (await open.count() === 0) await toggle.click();
        await open.waitFor();
      }
      await entry.waitFor();
    };
    const nav = page.locator('.gtd-nav');
    const olderRow = page.getByRole('button', { name: /^Open Choose tools/ });
    const newerRow = page.getByRole('button', { name: /^Open Practice joints/ });
    const archivedRow = page.getByText('Archived rehearsal', { exact: true });
    const assertSavedSort = async () => {
      await olderRow.waitFor();
      await newerRow.waitFor();
      const older = await olderRow.elementHandle();
      assert.ok(await newerRow.evaluate((newer, earlier) =>
        earlier.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING, older));
      await older.dispose();
    };
    try {
      await Promise.race([skip.waitFor(), (width === 390 ? toggle : entry).waitFor()]);
      if (await skip.isVisible()) await skip.click();
      await openSidebar();
      if (mode === 'composer-project') {
        const context = page.getByLabel('Thread context before sending');
        const projectLink = context.getByRole('link', { name: 'GTD Project Learn woodworking' });
        const projectPath = `/plugins/gtd/projects/${Buffer.from(JSON.stringify([ref.source, ref.id])).toString('base64url')}`;
        const openThread = async (id, title) => {
          await page.goto(`${base}/threads/${id}`);
          await page.getByTestId('app-page-header-content-row').getByText(title, { exact: true }).waitFor();
        };
        await openThread('fixture1', 'Choose tools');
        await projectLink.waitFor();
        assert.equal(await projectLink.getAttribute('href'), projectPath);
        await page.keyboard.press('Tab');
        await projectLink.focus();
        assert.equal(await projectLink.evaluate(el => el.matches(':focus-visible')), true);
        assert.notEqual(await projectLink.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
        await page.screenshot({ path: join(artifacts, `composer-project-${width}.png`) });
        await page.keyboard.press('Enter');
        await page.waitForURL(`${base}${projectPath}`);
        await nav.getByRole('heading', { name: 'Learn woodworking', exact: true }).waitFor();
        await openThread('fixture2', 'Practice joints');
        await context.getByRole('link', { name: 'Choose tools' }).waitFor();
        assert.equal(await context.getByRole('link', { name: /^GTD Project/ }).count(), 0);
        await openThread('unlinked', 'Unlinked thread');
        assert.equal(await context.getByRole('link', { name: /^GTD Project/ }).count(), 0);
        assert.deepEqual(errors, []);
        console.log(`${mode} ${width}: rendered and checked`);
        await page.close();
        continue;
      }
      if (mode === 'normal') {
        await assertSavedSort();
        assert.equal(await archivedRow.count(), 0);
        const actions = page.getByRole('button', { name: /^Threads actions/ });
        if (width === 1280) await page.getByText('Threads', { exact: true }).hover();
        assert.equal(await actions.evaluate(button => button.disabled), false);
        // The fixed Threads section disables its drag handle via an ancestor.
        await actions.click({ force: true });
        await page.getByRole('menuitem', { name: 'Organize', exact: true }).waitFor();
        const filter = page.getByRole('menuitem', { name: 'Filter', exact: true });
        await filter.waitFor();
        if (width === 390) await filter.click();
        else await filter.hover();
        const archivedFilter = page.getByRole('menuitemcheckbox', { name: 'Archived', exact: true });
        await archivedFilter.click();
        await archivedRow.waitFor();
        await page.screenshot({ path: join(artifacts, `thread-list-${width}.png`) });
        await archivedFilter.click();
        await archivedRow.waitFor({ state: 'hidden' });
        await page.keyboard.press('Escape');
        if (width === 1280) await page.keyboard.press('Escape');
        if (width === 1280) {
          await setPreference('sidebar.threadListProvider', 'gtd/projects');
          await page.reload();
          await page.locator('[data-thread-list-placeholder="missing"]').waitFor();
          await entry.waitFor();
          await setPreference('sidebar.threadListProvider', 'thread-list/thread-list');
          await page.reload();
          await assertSavedSort();
          await setPreference('sidebar.threadListProvider', '__automatic__');
          await page.reload();
          await assertSavedSort();
          console.log('Retired explicit GTD provider leaves a placeholder; selecting the bundled provider restores the saved sort.');
        }
      }
      await openSidebar();
      await entry.click();
      await page.waitForURL('**/plugins/gtd/areas');
      await nav.waitFor();
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `host-failure-${width}.png`) });
      console.error('Host diagnostics:', errors, consoleErrors, await page.locator('body').innerText());
      throw error;
    }
    const heading = name => nav.getByRole('heading', { name, exact: true, level: 1 });
    const assertDividers = async sectionCount => {
      const widths = await nav.locator('.gtd-detail-sections > section').evaluateAll(sections =>
        sections.map(section => [getComputedStyle(section).borderBlockStartWidth, getComputedStyle(section).borderBlockEndWidth]));
      assert.deepEqual(widths, Array.from({ length: sectionCount }, (_, i) => [i ? '1px' : '0px', '0px']));
    };
    const link = name => nav.getByRole('link', { name, exact: typeof name === 'string' });
    const breadcrumbs = nav.getByRole('navigation', { name: 'Breadcrumb' });
    const areasCrumb = breadcrumbs.getByRole('link', { name: 'Areas', exact: true });
    const filter = nav.getByLabel('Filter by project status', { exact: true });
    const threadFilter = nav.getByLabel('Filter by thread status', { exact: true });
    const selectActionFilter = async (section, name) => {
      const trigger = section.getByLabel('Filter by action status');
      await trigger.click();
      await section.getByRole('radio', { name, exact: true }).click();
      await trigger.press('Escape');
    };
    const switchArea = async name => {
      await areasCrumb.press('Enter');
      await heading('Areas').waitFor();
      if (name === undefined) return;
      await link(name).press('Enter');
      await heading(name).waitFor();
    };
    const openLearning = async () => {
      const learning = link('Learning');
      await learning.press('Enter');
      await heading('Learning').waitFor();
    };
    if (mode === 'browser-flow') {
      await heading('Areas').waitFor();
      const header = nav.locator('.gtd-page-header');
      const indexHeader = await header.boundingBox();
      const indexTitle = await heading('Areas').boundingBox();
      await link('Learning').getByText('1 project', { exact: true }).waitFor();
      await link('Home').getByText('0 projects', { exact: true }).waitFor();
      await link('Empty Area').getByText('0 projects', { exact: true }).waitFor();
      const count = await link('Learning').getByText('1 project', { exact: true }).boundingBox();
      const chevron = await link('Learning').locator('svg').boundingBox();
      assert.ok(Math.abs(chevron.x - count.x - count.width - 8) < 1);
      assert.ok(await nav.locator('.gtd-rows').evaluate(list => list.scrollWidth === list.clientWidth));
      await page.screenshot({ path: join(artifacts, `areas-index-${width}.png`) });
      const emptyHref = await link('Empty Area').getAttribute('href');
      await openLearning();
      const areaUrl = page.url();
      assert.equal((await header.boundingBox()).height, indexHeader.height);
      assert.equal((await heading('Learning').boundingBox()).y, indexTitle.y);
      assert.equal(await heading('Learning').evaluate(el => el.matches(':focus')), true);
      assert.equal(await nav.getByRole('combobox', { name: 'Area', exact: true }).count(), 0);
      assert.equal(await nav.getByRole('navigation', { name: 'Switch Area' }).count(), 0);
      assert.equal(await link('Home').count(), 0);
      await link('Learn woodworking').waitFor();
      await link('Practice plan').waitFor();
      assert.equal(await link('Choose tools').isVisible(), false);
      await threadFilter.press('Enter');
      const active = nav.getByRole('checkbox', { name: 'Active' });
      const archived = nav.getByRole('checkbox', { name: 'Archived' });
      assert.equal(await active.isChecked(), true);
      await page.keyboard.press('Tab');
      assert.equal(await archived.evaluate(el => el.matches(':focus-visible')), true);
      await page.keyboard.press('Space');
      await link('Past practice plan').waitFor();
      await link('Practice plan').waitFor();
      await page.screenshot({ path: join(artifacts, `area-thread-filter-${width}.png`) });
      await active.click();
      assert.equal(await link('Practice plan').isVisible(), false);
      await page.keyboard.press('Escape');
      await page.screenshot({ path: join(artifacts, `area-home-${width}.png`) });
      await filter.focus();
      await page.keyboard.press('Enter');
      assert.equal(await nav.getByRole('radio', { name: 'Active' }).isChecked(), true);
      await page.keyboard.press('Tab');
      assert.equal(await nav.getByRole('radio', { name: 'Active' }).evaluate(el => el.matches(':focus-visible')), true);
      await page.keyboard.press('ArrowRight');
      await link('Build a bench').waitFor();
      assert.equal(await link('Learn woodworking').isVisible(), false);
      await page.keyboard.press('Escape');
      assert.equal(await filter.evaluate(el => el.matches(':focus')), true);
      await switchArea('Home');
      await nav.getByText('No someday projects in this Area.').waitFor();
      await filter.click();
      assert.equal(await nav.getByRole('radio', { name: 'Someday' }).isChecked(), true);
      await nav.getByRole('radio', { name: 'Done' }).click();
      await link('Find a hammer').waitFor();
      await nav.getByRole('radio', { name: 'All' }).click();
      await page.keyboard.press('Escape');
      await switchArea('Learning');
      await link(/Restore a plane Deferred/).waitFor();
      const deferredHref = await link(/Restore a plane Deferred/).getAttribute('href');
      await filter.click();
      assert.equal(await nav.getByRole('radio', { name: 'All' }).isChecked(), true);
      await page.screenshot({ path: join(artifacts, `project-filter-${width}.png`) });
      await page.keyboard.press('Escape');
      const project = link(/Learn woodworking Active/);
      const projectHref = await project.getAttribute('href');
      assert.match(projectHref, /^\/plugins\/gtd\/projects\/[^/]+$/);
      await project.focus();
      await page.keyboard.press('Enter');
      await heading('Learn woodworking').waitFor();
      await link('Choose tools').waitFor();
      assert.equal(await link('Archived rehearsal').isVisible(), false);
      await threadFilter.press('Enter');
      assert.equal(await active.isChecked(), true);
      assert.equal(await active.isDisabled(), true);
      await page.keyboard.press('Tab');
      assert.equal(await archived.evaluate(el => el.matches(':focus-visible')), true);
      await page.keyboard.press('Space');
      await link('Archived rehearsal').waitFor();
      await link('Choose tools').waitFor();
      await page.screenshot({ path: join(artifacts, `thread-filter-${width}.png`) });
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Space');
      assert.equal(await archived.isDisabled(), true);
      assert.equal(await link('Choose tools').isVisible(), false);
      await page.keyboard.press('Escape');
      assert.equal(await threadFilter.evaluate(el => el.matches(':focus')), true);
      await nav.getByRole('button', { name: 'Show more archived threads' }).click();
      await link('Earlier rehearsal').waitFor();
      await page.screenshot({ path: join(artifacts, `project-archived-${width}.png`) });
      await page.goBack();
      await page.waitForURL(areaUrl);
      await heading('Learning').waitFor();
      await link(/Restore a plane Deferred/).waitFor();
      await page.goForward();
      await heading('Learn woodworking').waitFor();
      await breadcrumbs.getByRole('link', { name: 'Learning' }).click();
      await heading('Learning').waitFor();
      await areasCrumb.press('Enter');
      await heading('Areas').waitFor();
      assert.equal(await breadcrumbs.count(), 0);
      await page.goto(new URL(projectHref, base).href);
      await heading('Learn woodworking').waitFor();
      await link('Choose tools').waitFor();
      await page.goto(new URL(deferredHref, base).href);
      await heading('Restore a plane').waitFor();
      await nav.getByText('No threads', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `project-empty-threads-${width}.png`) });
      await page.goto(new URL(emptyHref, base).href);
      await heading('Empty Area').waitFor();
      await nav.getByText('No projects in this Area yet.').waitFor();
      await nav.getByText('No threads', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `area-empty-threads-${width}.png`) });
      await threadFilter.click();
      assert.equal(await archived.isEnabled(), true);
      await page.goto(`${base}/plugins/gtd/projects`);
      await heading('Areas').waitFor();
      await link('Empty Area').waitFor();
    } else if (mode === 'normal') {
      await openLearning();
      assert.equal(await nav.getByLabel('Actions for area Learning').count(), 0);
      const areaThreads = nav.getByRole('region', { name: 'Threads', exact: true });
      const newAreaThread = areaThreads.getByRole('button', { name: 'New thread for Area Learning' });
      await newAreaThread.focus();
      await page.keyboard.press('Tab');
      assert.equal(await threadFilter.evaluate(el => el.matches(':focus-visible')), true);
      await page.keyboard.press('Tab');
      assert.equal(await nav.getByRole('button', { name: 'Refresh GTD' }).count(), 0);
      assert.equal(await threadFilter.evaluate(el => el.matches(':focus')), false);
      const plus = nav.getByRole('button', { name: 'New thread for Learn woodworking' });
      await page.keyboard.press('Tab'); await plus.focus();
      assert.notEqual(await plus.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      if (width === 390) assert.ok(await plus.evaluate(el => el.getBoundingClientRect().height >= 44));
      await page.screenshot({ path: join(artifacts, `focus-${width}.png`) });
      const projectMenu = nav.getByLabel('Actions for project Learn woodworking');
      await projectMenu.focus();
      await page.keyboard.press('Enter');
      const actions = projectMenu.locator('..');
      assert.equal(await actions.getByRole('button', { name: 'Rename', exact: true }).count(), 0);
      const markDone = actions.getByRole('button', { name: 'Mark as done', exact: true });
      await markDone.focus();
      await page.keyboard.press('Enter');
      const confirm = nav.getByRole('dialog', { name: 'Mark as done' });
      await confirm.waitFor();
      await page.keyboard.press('Escape');
      await confirm.waitFor({ state: 'hidden' });
      assert.equal(await projectMenu.evaluate(el => el.matches(':focus')), true);
      await link('Learn woodworking').click();
      const projectUrl = page.url();
      await heading('Learn woodworking').waitFor();
      await link('Choose tools').waitFor();
      await nav.getByRole('button', { name: 'Actions for Choose tools' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      const nativeInput = page.getByRole('textbox', { name: 'Thread name' });
      await nativeInput.waitFor();
      await page.screenshot({ path: join(artifacts, `host-rename-${width}.png`) });
      await page.keyboard.press('Escape');
      await nativeInput.waitFor({ state: 'hidden' });
      // Native thread action submenu is the association/reassignment/unlink surface.
      await nav.getByRole('button', { name: 'Actions for Choose tools' }).click();
      await page.getByRole('menuitem', { name: /GTD project/ }).click();
      await page.getByRole('menuitem', { name: 'No GTD project', exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `association-${width}.png`) });
      await page.getByRole('menuitem', { name: 'No GTD project', exact: true }).click();
      await link('Choose tools').waitFor({ state: 'hidden' });
      await areasCrumb.click();
      await heading('Areas').waitFor();
      await nav.getByText('Thread associations', { exact: true }).click();
      await nav.getByText('Unassigned threads (1)', { exact: true }).waitFor();
      await nav.getByText('Unassigned threads (1)', { exact: true }).click();
      await nav.getByRole('button', { name: 'Actions for Choose tools' }).click();
      await page.getByRole('menuitem', { name: /GTD project/ }).click();
      await page.getByRole('menuitem', { name: 'Learn woodworking', exact: true }).click();
      await nav.getByText('Unassigned threads (0)', { exact: true }).waitFor();
      await link('Learning').click();
      await link('Learn woodworking').click();
      await link('Choose tools').click();
      await page.waitForURL('**/threads/fixture1');
      await page.getByTestId('app-page-header-content-row').getByText('Choose tools', { exact: true }).waitFor();
      await nav.waitFor({ state: 'hidden' });
      await openSidebar();
      await assertSavedSort();
      await page.goto(projectUrl);
      await heading('Learn woodworking').waitFor();
      await page.reload();
      await heading('Learn woodworking').waitFor();
      const create = nav.getByRole('button', { name: 'New thread for Learn woodworking' }); await create.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await page.waitForURL('**/threads/fixture1');
      assert.equal(creations, 1);
    } else if (native) {
      await openLearning();
      await link('Learn woodworking').focus();
      await page.waitForResponse(async response =>
        response.url().endsWith('/rpc/inventoryRevision') && typeof (await response.json()).result === 'string');
      assert.equal(await link('Legacy label').count(), 0);
      const someday = join(vault, 'Projects/Someday/Learn woodworking.md');
      await writeFile(join(vault, ref.id), projectNote('Edited in vault'));
      await rename(join(vault, ref.id), someday);
      await link('Learn woodworking').waitFor({ state: 'hidden' });
      assert.ok(await heading('Learning').evaluate(el => el.matches(':focus')));
      await filter.click();
      await nav.getByRole('radio', { name: 'Someday' }).click();
      await page.keyboard.press('Escape');
      await link('Learn woodworking').waitFor();
      assert.equal(await link('Edited in vault').count(), 0);
      await rename(someday, join(vault, ref.id));
      await link('Learn woodworking').waitFor({ state: 'hidden' });
      await filter.click();
      await nav.getByRole('radio', { name: 'Active' }).click();
      await page.keyboard.press('Escape');
      await link('Learn woodworking').waitFor();
      const added = join(vault, 'Projects/New.md');
      const outside = join(vault, 'Elsewhere/New.md');
      const renamed = join(vault, 'Projects/Renamed.md');
      await writeFile(added, projectNote('Created in vault'));
      await link('New').waitFor();
      await rename(added, outside);
      await link('New').waitFor({ state: 'hidden' });
      await rename(outside, renamed);
      await link('Renamed').waitFor();
      const href = await link('Renamed').getAttribute('href');
      assert.deepEqual(JSON.parse(Buffer.from(href.split('/').at(-1), 'base64url').toString()), ['one', 'Projects/Renamed.md']);
      await unlink(renamed);
      await link('Renamed').waitFor({ state: 'hidden' });
      await page.screenshot({ path: join(artifacts, `native-refresh-${width}.png`) });
      await switchArea();
      const areaNote = join(vault, 'Areas/Workshop.md');
      const renamedArea = join(vault, 'Areas/Studio.md');
      await writeFile(areaNote, '# Workshop');
      await link('Workshop').waitFor();
      await rename(areaNote, renamedArea);
      await link('Studio').waitFor();
      await link('Workshop').waitFor({ state: 'hidden' });
      await unlink(renamedArea);
      await link('Studio').waitFor({ state: 'hidden' });
    } else if (mode === 'auto-refresh') {
      await openLearning();
      const existing = link('Learn woodworking');
      await existing.focus();
      let resume;
      heldRead = new Promise(resolve => { resume = resolve; });
      const before = inventoryReads;
      extraProject = { id: 'Projects/New project.md', title: 'New project', status: 'active', areaId: assignedArea };
      publish(1);
      publish(2);
      for (let attempt = 0; inventoryReads === before && attempt < 60; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(inventoryReads, before + 1);
      assert.ok(await existing.isVisible());
      assert.ok(await existing.evaluate(el => el.matches(':focus')));
      heldRead = undefined;
      resume();
      await link('New project').waitFor();
      assert.ok(await existing.evaluate(el => el.matches(':focus')));
      extraProject = { ...extraProject, id: 'Projects/Renamed project.md', title: 'Renamed project' };
      publish(3);
      await link('Renamed project').waitFor();
      await link('New project').waitFor({ state: 'hidden' });
      extraProject = null;
      await link('Renamed project').focus();
      publish(4);
      await link('Renamed project').waitFor({ state: 'hidden' });
      assert.ok(await heading('Learning').evaluate(el => el.matches(':focus')));
      title = 'Reconciled on focus';
      projectId = 'Projects/Reconciled on focus.md';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await link('Reconciled on focus').waitFor();
      failInventory = true;
      publish(5);
      const retry = nav.getByRole('button', { name: 'Retry GTD inventory' });
      await retry.waitFor();
      assert.ok(await link('Reconciled on focus').isVisible());
      await retry.focus();
      await page.screenshot({ path: join(artifacts, `auto-refresh-retry-${width}.png`) });
      failInventory = false;
      title = 'Recovered project';
      projectId = 'Projects/Recovered project.md';
      await page.keyboard.press('Enter');
      await link('Recovered project').waitFor();
      await retry.waitFor({ state: 'hidden' });
      assert.ok(await heading('Learning').evaluate(el => el.matches(':focus')));
      await page.screenshot({ path: join(artifacts, `auto-refresh-${width}.png`) });
    } else if (mode === 'section-filters') {
      await openLearning();
      for (const [sectionName, addName, filterLabel] of [
        ['Actions', 'Add action', 'Action status'],
        ['Projects', 'Add project', 'Project status'],
        ['Threads', 'New thread for Area Learning', 'Thread status'],
      ]) {
        const section = nav.getByRole('region', { name: sectionName, exact: true });
        const add = section.getByRole('button', { name: addName, exact: true });
        const filter = section.getByLabel(`Filter by ${filterLabel.toLowerCase()}`, { exact: true });
        await add.waitFor();
        assert.ok(await filter.locator('svg').isVisible());
        assert.equal(await filter.innerText(), '');
        assert.equal(await filter.getAttribute('title'), 'Filter');
        const addBox = await add.boundingBox();
        const filterBox = await filter.boundingBox();
        assert.ok(addBox && filterBox && filterBox.x >= addBox.x + addBox.width);
        assert.equal(filterBox.y, addBox.y);
        await add.focus();
        await page.keyboard.press('Tab');
        assert.ok(await filter.evaluate(el => el.matches(':focus-visible')));
        await page.keyboard.press('Enter');
        const menu = section.getByRole('group', { name: filterLabel, exact: true });
        await menu.waitFor();
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
      }
    } else if (mode === 'area-actions') {
      const actions = nav.getByRole('region', { name: 'Actions', exact: true });
      const openArea = async title => {
        await nav.getByRole('link', { name: 'Areas', exact: true }).click();
        await nav.getByRole('link', { name: title, exact: true }).click();
      };
      await nav.getByRole('link', { name: 'Learning', exact: true }).click();
      await actions.getByText('Loading actions…').waitFor();
      for (let i = 0; i < 100 && !releaseActions; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(releaseActions);
      actionState = 'ready';
      releaseActions();
      const actionLink = actions.getByRole('link', { name: 'workshop plan' });
      await actionLink.waitFor();
      assert.equal(await actionLink.getAttribute('href'), 'https://example.com/plan');
      assert.equal(await actions.getByText('Book the room').count(), 0);
      const boxes = actions.getByRole('checkbox');
      assert.equal(await boxes.count(), 2);
      const remaining = actions.getByRole('checkbox', { name: 'Bring the workshop plan' });
      const completing = actions.getByRole('checkbox', { name: 'Pack the tools' });
      assert.equal(await remaining.isChecked(), false);
      assert.equal(await completing.isChecked(), false);
      refuseAction = true;
      await completing.focus();
      await page.keyboard.press('Space');
      await actions.getByRole('alert').getByText(/Area note changed/).waitFor();
      assert.equal(await completing.isChecked(), false);
      assert.equal(await page.getByText('Action marked done', { exact: true }).count(), 0);
      refuseAction = false;
      await completing.locator('xpath=self::*[@aria-disabled="false"]').waitFor();
      await page.keyboard.press('Space');
      const exiting = actions.locator('.gtd-action-exiting');
      await exiting.waitFor();
      assert.equal(await exiting.evaluate(el => getComputedStyle(el).animationName), 'gtd-action-complete');
      await exiting.waitFor({ state: 'detached' });
      assert.equal(await actions.getByText('Pack the tools').count(), 0);
      assert.equal(await actions.getByText('Action completed.').count(), 0);
      assert.ok(await remaining.evaluate(el => el.matches(':focus')));
      const completionToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Action marked done' });
      await completionToast.waitFor();
      const undo = completionToast.getByRole('button', { name: 'Undo', exact: true });
      await undo.waitFor();
      await page.screenshot({ path: join(artifacts, `action-undo-${width}.png`) });
      if (width === 390) await undo.tap();
      else { await undo.focus(); await page.keyboard.press('Enter'); }
      await completing.waitFor();
      assert.equal(await completing.isChecked(), false);
      await completing.locator('xpath=self::*[@aria-disabled="false"]').waitFor();
      await completing.press('Space');
      await completing.waitFor({ state: 'detached' });
      const add = actions.getByRole('button', { name: 'Add action' });
      const addProject = nav.getByRole('button', { name: 'Add project' });
      const projects = nav.getByRole('region', { name: 'Projects', exact: true });
      const toggleProjects = projects.getByRole('button', { name: 'Projects', exact: true });
      const toggleActions = actions.getByRole('button', { name: 'Actions', exact: true });
      for (const control of [add, addProject]) {
        assert.ok(await control.locator('svg').isVisible());
        assert.equal(await control.innerText(), '');
      }
      await add.click();
      const draft = actions.getByRole('textbox', { name: 'Action', exact: true });
      assert.ok(await draft.evaluate(el => el.matches(':focus')));
      await draft.fill('Check the supplies');
      await toggleActions.press('Space');
      assert.equal(await toggleActions.getAttribute('aria-expanded'), 'false');
      assert.equal(await add.count(), 0);
      assert.equal(await draft.count(), 0);
      assert.equal(await actions.getByLabel('Filter by action status').count(), 0);
      assert.ok(await addProject.isVisible());
      await toggleProjects.press('Enter');
      assert.equal(await toggleProjects.getAttribute('aria-expanded'), 'false');
      assert.equal(await addProject.count(), 0);
      assert.equal(await projects.getByLabel('Filter by project status').count(), 0);
      assert.equal(await projects.getByRole('link').count(), 0);
      const threads = nav.getByRole('region', { name: 'Threads', exact: true });
      const toggleThreads = threads.getByRole('button', { name: 'Threads', exact: true });
      const addThread = threads.getByRole('button', { name: 'New thread for Area Learning' });
      const filterThreads = threads.getByLabel('Filter by thread status');
      await addThread.waitFor();
      await toggleThreads.click();
      assert.equal(await toggleThreads.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggleThreads.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
      assert.equal(await addThread.count(), 0);
      assert.equal(await filterThreads.count(), 0);
      await assertDividers(4);
      await page.screenshot({ path: join(artifacts, `area-sections-folded-${width}.png`) });
      await toggleThreads.press('Space');
      await addThread.waitFor();
      await filterThreads.waitFor();
      await toggleProjects.press('Enter');
      await addProject.waitFor();
      await toggleActions.press('Space');
      await draft.waitFor();
      await assertDividers(4);
      assert.equal(await draft.inputValue(), 'Check the supplies');
      await draft.focus();
      await page.screenshot({ path: join(artifacts, `area-actions-add-${width}.png`) });
      refuseAction = true;
      await draft.press('Enter');
      await actions.getByRole('alert').getByText(/Area note changed/).waitFor();
      assert.equal(await draft.inputValue(), 'Check the supplies');
      refuseAction = false;
      await actions.getByRole('button', { name: 'Add', exact: true }).locator('xpath=self::*[@aria-disabled="false"]').waitFor();
      await draft.press('Enter');
      await actions.getByRole('checkbox', { name: 'Check the supplies' }).waitFor();
      assert.ok(await add.evaluate(el => el.matches(':focus')));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await actions.getByText('Check the supplies', { exact: true }).click();
      await actions.getByText('Check the supplies').waitFor({ state: 'detached' });
      await heading('Learning').focus();
      for (let i = 0; i < 8 && !await actionLink.evaluate(el => el.matches(':focus')); i++) await page.keyboard.press('Tab');
      assert.ok(await actionLink.evaluate(el => el.matches(':focus')));
      await page.screenshot({ path: join(artifacts, `area-actions-populated-${width}.png`) });
      const row = actions.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'workshop plan' }) });
      const bounds = await row.boundingBox();
      assert.ok(bounds);
      await row.click({ position: { x: bounds.width * 0.7, y: bounds.height / 2 } });
      await actions.getByText('No open actions.').waitFor();
      await selectActionFilter(actions, 'Done');
      const done = actions.getByRole('checkbox', { name: 'Book the room' });
      assert.equal(await done.isChecked(), true);
      await done.click();
      await actions.getByText('Book the room').waitFor({ state: 'detached' });
      await selectActionFilter(actions, 'All');
      await done.waitFor();
      assert.equal(await done.isChecked(), false);
      await actions.getByText('Book the room', { exact: true }).click();
      await actions.locator('.gtd-action-row').filter({ hasText: 'Book the room' }).locator('input:checked').waitFor();
      assert.ok(await done.isChecked());
      await add.click();
      await draft.fill('Prepare the [workshop](https://example.com/workshop)');
      await draft.press('Enter');
      const conversionMenu = actions.getByLabel('Options for action Prepare the [workshop](https://example.com/workshop)', { exact: true });
      const convert = conversionMenu.locator('..').getByRole('button', { name: 'Create project', exact: true });
      refuseAction = true;
      await conversionMenu.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.ok(await convert.evaluate(el => el.matches(':focus-visible')));
      await page.screenshot({ path: join(artifacts, `create-project-from-action-${width}.png`) });
      await page.keyboard.press('Enter');
      await actions.getByRole('status').getByText('Preparing project title…').waitFor();
      for (let i = 0; i < 100 && !releaseProjectName; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(releaseProjectName);
      releaseProjectName();
      const dialog = nav.getByRole('dialog', { name: 'Create project from action', exact: true });
      const projectName = dialog.getByRole('textbox', { name: 'Project name' });
      await dialog.getByRole('alert').getByText('The naming agent could not suggest a title. Enter a project name.').waitFor();
      assert.equal(await projectName.inputValue(), '');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(conversionRequests, 0);
      await conversionMenu.waitFor();
      refuseAction = false;
      if (width === 390) {
        await conversionMenu.tap();
        await convert.tap();
      } else {
        await conversionMenu.press('Enter');
        await convert.press('Enter');
      }
      await dialog.waitFor();
      assert.equal(await projectName.inputValue(), 'Prepare the workshop');
      assert.ok(await projectName.evaluate(el => el.matches(':focus')));
      assert.equal(conversionRequests, 0);
      await projectName.fill('Organize the workshop');
      await page.screenshot({ path: join(artifacts, `confirm-project-from-action-${width}.png`) });
      await projectName.press('Enter');
      const conversionToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Created “Organize the workshop”' });
      await conversionToast.waitFor();
      await conversionMenu.waitFor({ state: 'detached' });
      await projects.getByRole('link', { name: 'Organize the workshop', exact: true }).waitFor();
      assert.ok(await add.evaluate(el => el.matches(':focus')));
      await conversionToast.getByRole('button', { name: 'Undo', exact: true }).click();
      await conversionMenu.waitFor();
      await page.getByText('Action restored', { exact: true }).waitFor();
      await openArea('Home');
      await actions.getByRole('status').getByText('Could not load actions. Check the Area note in Obsidian.').waitFor();
      await openArea('Folder');
      await actions.getByText('Add an Area note in Obsidian to record actions.').waitFor();
      actionState = 'empty';
      await openArea('Learning');
      await actions.getByText('No actions recorded.').waitFor();
    } else if (mode === 'area-standard') {
      const standard = nav.getByRole('region', { name: 'Standard' });
      await nav.getByRole('link', { name: 'Learning', exact: true }).click();
      await standard.getByText('Practice weekly.', { exact: true }).waitFor();
      const edit = standard.getByRole('button', { name: 'Edit standard' });
      assert.equal(await edit.getAttribute('title'), 'Edit standard');
      assert.equal(await edit.innerText(), '');
      assert.ok(await edit.locator('svg').isVisible());
      const headingBox = await standard.getByRole('heading', { name: 'Standard' }).boundingBox();
      const editBox = await edit.boundingBox();
      const gap = editBox.x - (headingBox.x + headingBox.width);
      assert.ok(gap >= 0 && gap <= 8, 'Pencil belongs next to the Standard heading');
      if (width === 390) assert.ok(editBox.width >= 44 && editBox.height >= 44);
      await page.screenshot({ path: join(artifacts, `standard-pencil-${width}.png`) });
      const editor = standard.getByRole('textbox', { name: 'Standard' });
      const save = standard.getByRole('button', { name: 'Save', exact: true });
      await edit.focus();
      await page.keyboard.press('Enter');
      assert.ok(await editor.evaluate(el => el === document.activeElement));
      await editor.fill('Discarded draft');
      await standard.getByRole('button', { name: 'Cancel' }).click();
      assert.ok(await edit.evaluate(el => el === document.activeElement));
      assert.equal(standardSaves.length, 0);
      await edit.click();
      await editor.fill('Practice daily.\n\nKeep notes.');
      await page.screenshot({ path: join(artifacts, `standard-edit-${width}.png`) });
      await save.click();
      await standard.getByText('Standard saved locally in Obsidian.').waitFor();
      assert.equal(standardSaves[0].id, 'Areas/Learning.md');
      assert.equal(standardSaves[0].expectedHash, 'a'.repeat(64));
      await edit.click();
      await editor.fill('Conflicting draft');
      await save.click();
      await standard.getByRole('alert').getByText(/note changed in Obsidian/).waitFor();
      assert.equal(await editor.inputValue(), 'Conflicting draft');
      assert.ok(await save.isDisabled());
      await standard.getByRole('button', { name: 'Load current standard' }).click();
      await standard.getByText('Edit made in Obsidian.', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `standard-view-${width}.png`) });
      await edit.click();
      await editor.fill('Unconfirmed draft');
      await save.click();
      await standard.getByRole('alert').getByText(/save is unconfirmed/).waitFor();
      await standard.getByText(standardSaves.at(-1).operationId, { exact: true }).waitFor();
      assert.ok(await save.isDisabled());
      await switchArea('Home');
      await standard.getByRole('alert').getByText(/Could not read the standard/).waitFor();
      assert.equal(await standard.count(), 1, 'Switching Areas must replace the previous Standard section');
      await standard.getByRole('button', { name: 'Try again' }).click();
      await standard.getByRole('button', { name: 'Add standard' }).click();
      assert.equal(await editor.inputValue(), '');
      assert.ok(await save.isDisabled());
      await editor.fill('Review household tasks weekly.');
      await save.click();
      await standard.getByText('Review household tasks weekly.', { exact: true }).waitFor();
      await switchArea('Folder');
      await standard.getByText('Add an Area note in Obsidian to set a standard.').waitFor();
      await switchArea('Learning');
      await standard.getByText('Edit made in Obsidian.', { exact: true }).waitFor();
      assert.equal(await standard.count(), 1);
      await switchArea();
      assert.equal(await standard.count(), 0);
      assert.ok(!standardReads.includes('Areas/Folder/'));
      assert.equal(standardSaves.length, 4);
    } else if (mode === 'area-mail') {
      await openLearning();
      const row = name => nav.getByRole('link', { name, exact: true }).locator('..');
      await row(title).getByText('Unread email', { exact: true }).waitFor();
      await row('Unknown mail').getByText('Mail status incomplete', { exact: true }).waitFor();
      await row('Skipped check').getByText('Mail status incomplete', { exact: true }).waitFor();
      assert.equal(await row('Read mail').locator('[data-mail]').count(), 0);
      await link(title).focus();
      assert.ok(await link(title).evaluate(node => node === document.activeElement));
      await page.screenshot({ path: join(artifacts, `area-mail-badges-${width}.png`) });
      areaUnread = false;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await row(title).getByText('Unread email', { exact: true }).waitFor({ state: 'detached' });
      await filter.click();
      await nav.getByRole('radio', { name: 'Done', exact: true }).click();
      await nav.getByText('No done projects in this Area.', { exact: true }).waitFor();
      assert.equal(await nav.locator('[data-mail]').count(), 0);
    } else if (mode === 'project-actions-list') {
      await openLearning();
      await link(title).click();
      const actions = nav.getByRole('region', { name: 'Actions', exact: true });
      await actions.getByText('Loading actions…').waitFor();
      for (let i = 0; i < 100 && !releaseActions; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(releaseActions);
      actionState = 'ready';
      releaseActions();
      const plan = actions.getByRole('link', { name: 'workshop plan', exact: true });
      await plan.waitFor();
      assert.equal(await actions.getByRole('checkbox').count(), 2);
      assert.equal(await actions.getByText('Book the room').count(), 0);
      const add = actions.getByRole('button', { name: 'Add action', exact: true });
      const toggle = actions.getByRole('button', { name: 'Actions', exact: true });
      await toggle.press('Space');
      assert.equal(await plan.count(), 0);
      assert.equal(await add.count(), 0);
      await toggle.press('Space');
      await plan.waitFor();
      await add.click();
      const draft = actions.getByRole('textbox', { name: 'Action', exact: true });
      await draft.fill('Check the workbench');
      await draft.press('Enter');
      const task = actions.getByText('Check the workbench', { exact: true });
      await task.waitFor();
      await task.click();
      await task.waitFor({ state: 'detached' });
      const completionToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Action marked done' });
      await completionToast.getByRole('button', { name: 'Undo', exact: true }).click();
      await task.waitFor();
      await actions.getByRole('checkbox', { name: 'Check the workbench' }).locator('xpath=self::*[@aria-disabled="false"]').waitFor();
      await task.click();
      await task.waitFor({ state: 'detached' });
      assert.ok(await plan.isVisible());
      await selectActionFilter(actions, 'Done');
      const completed = actions.getByRole('checkbox', { name: 'Check the workbench' });
      assert.equal(await completed.isChecked(), true);
      assert.equal(await plan.count(), 0);
      const actionMenu = actions.getByLabel('Options for action Check the workbench');
      await actionMenu.press('Enter');
      await actionMenu.locator('..').getByRole('button', { name: 'Edit…' }).press('Enter');
      const edit = actions.getByRole('textbox', { name: 'Edit action' });
      assert.equal(await edit.inputValue(), 'Check the workbench');
      assert.ok(await edit.evaluate(el => el.matches(':focus')));
      await page.screenshot({ path: join(artifacts, `edit-action-${width}.png`) });
      await edit.fill('Inspect the workbench');
      await edit.press('Enter');
      const renamed = actions.getByRole('checkbox', { name: 'Inspect the workbench' });
      await renamed.waitFor();
      assert.ok(await renamed.isChecked());
      await selectActionFilter(actions, 'All');
      assert.ok(await plan.isVisible());
      assert.ok(await renamed.isChecked());
      await selectActionFilter(actions, 'Open');
      assert.equal(await renamed.count(), 0);
      const threads = nav.getByRole('region', { name: 'Threads', exact: true });
      const toggleThreads = threads.getByRole('button', { name: 'Threads', exact: true });
      const newThreadName = `New thread for ${title}`;
      const newThread = threads.getByRole('button', { name: newThreadName });
      await newThread.waitFor();
      assert.equal(await nav.locator('.gtd-page-heading').getByRole('button', { name: newThreadName }).count(), 0);
      const filterThreads = threads.getByLabel('Filter by thread status');
      await newThread.focus();
      await page.keyboard.press('Tab');
      assert.ok(await filterThreads.evaluate(el => el.matches(':focus')));
      await toggleThreads.press('Enter');
      assert.equal(await filterThreads.count(), 0);
      assert.equal(await newThread.count(), 0);
      await assertDividers(3);
      await toggleThreads.press('Enter');
      await newThread.waitFor();
      await page.screenshot({ path: join(artifacts, `project-actions-list-${width}.png`) });
      actionState = 'empty';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await actions.getByText('No actions recorded.', { exact: true }).waitFor();
      failProjectActions = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await actions.getByText('Could not load actions. Check the project note in Obsidian.', { exact: true }).waitFor();
      actionState = 'ready';
      failProjectActions = false;
      await actions.getByRole('button', { name: 'Try again' }).click();
      const menu = actions.getByLabel('Options for action Inspect the workbench');
      await selectActionFilter(actions, 'Done');
      const start = menu.locator('..').getByRole('button', { name: 'Start a thread' });
      await menu.press('Enter');
      await page.keyboard.press('Tab');
      assert.ok(await start.evaluate(el => el.matches(':focus-visible')));
      await page.screenshot({ path: join(artifacts, `start-action-thread-${width}.png`) });
      await page.keyboard.press('Enter');
      await nav.getByText('The note changed. Review the refreshed action before starting a thread.', { exact: true }).waitFor();
      await menu.press('Enter');
      await start.press('Enter');
      await page.waitForURL('**/threads/fixture1');
      assert.equal(actionCreations.length, 2);
      assert.deepEqual(actionCreations.map(({ requestId, ...input }) => input),
        Array(2).fill({ ...ref, kind: 'project', version: actionVersion, line: 1 }));
    } else if (mode === 'correspondence') {
      await openLearning();
      const areaUrl = page.url();
      await page.evaluate(() => {
        window.duplicateCorrespondence = false;
        new MutationObserver(() => {
          const sections = [...document.querySelectorAll('.gtd-nav section')].filter(section =>
            section.querySelector(':scope > div > h2')?.textContent === 'Correspondence');
          const hrefs = sections.flatMap(section => [...section.querySelectorAll('a[href]')].map(link => link.href));
          if (sections.length > 1 || new Set(hrefs).size !== hrefs.length) window.duplicateCorrespondence = true;
        }).observe(document.body, { subtree: true, childList: true });
      });
      let showLinks, showStatus;
      heldCorrespondence = new Promise(resolve => { showLinks = resolve; });
      heldStatus = new Promise(resolve => { showStatus = resolve; });
      await link(title).click();
      const correspondence = nav.getByRole('region', { name: 'Correspondence' });
      const assertSingle = async hrefs => {
        assert.equal(await correspondence.count(), 1);
        assert.equal(await nav.getByRole('heading', { name: 'Correspondence', exact: true }).count(), 1);
        assert.deepEqual(await correspondence.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))), hrefs);
      };
      await correspondence.getByText('Loading correspondence…', { exact: true }).waitFor();
      await assertSingle([]);
      showLinks();
      await correspondence.getByText('Checking mail…', { exact: true }).first().waitFor();
      await assertSingle([gmail, fastmail, fastmailReply, fastmailOther, fastmailUnresolved]);
      showStatus();
      await correspondence.getByRole('heading', { name: 'Active conversations' }).waitFor();
      const workshop = correspondence.getByRole('link', { name: 'Workshop logistics' });
      await correspondence.getByText('2 unread', { exact: true }).waitFor();
      const visibleLinks = [gmail, fastmail, fastmailOther, fastmailUnresolved];
      await assertSingle(visibleLinks);
      assert.equal(await workshop.getAttribute('href'), gmail);
      assert.equal(await correspondence.getByRole('link', { name: 'Venue booking' }).getAttribute('href'), fastmail);
      assert.equal(await correspondence.getByRole('link', { name: 'Lookalike' }).count(), 0);
      assert.equal(await correspondence.getByText('3 unread', { exact: true }).count(), 1);
      await correspondence.getByText('Conversation not found', { exact: true }).waitFor();
      const refresh = correspondence.getByRole('button', { name: 'Refresh email' });
      const toggle = correspondence.getByRole('button', { name: 'Correspondence', exact: true });
      await toggle.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await refresh.count(), 0);
      await assertSingle([]);
      await page.screenshot({ path: join(artifacts, `project-correspondence-folded-${width}.png`) });
      await toggle.press('Space');
      await refresh.waitFor();
      await assertSingle(visibleLinks);
      await refresh.focus();
      await page.keyboard.press('Tab');
      assert.ok(await workshop.evaluate(node => node === document.activeElement));
      const archive = correspondence.locator('details').filter({ hasText: 'Archived conversations' });
      const summary = archive.locator('summary');
      assert.equal(await summary.innerText(), 'Archived conversations (1)');
      const previous = archive.getByRole('link', { name: 'Previous booking' });
      assert.equal(await previous.isVisible(), false);
      await summary.focus();
      await page.keyboard.press('Enter');
      await previous.waitFor();
      await page.keyboard.press('Tab');
      assert.ok(await previous.evaluate(node => node === document.activeElement));
      assert.equal(await previous.getAttribute('href'), archivedMail);
      assert.equal(await archive.locator('.gtd-correspondence-detail').count(), 0);
      assert.ok(await correspondence.evaluate(node => node.scrollWidth === node.clientWidth));
      await page.screenshot({ path: join(artifacts, `project-correspondence-${width}.png`) });
      await summary.click();
      unread = 0;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await correspondence.getByText('2 unread', { exact: true }).waitFor({ state: 'detached' });
      await assertSingle(visibleLinks);
      const snooze = correspondence.getByRole('button', { name: 'Snooze Workshop logistics' });
      await snooze.focus();
      await page.keyboard.press('Enter');
      const dateForm = correspondence.getByRole('form', { name: 'Return date for Workshop logistics' });
      await dateForm.getByLabel('Return date').fill(snoozeDate(7));
      await dateForm.getByRole('button', { name: 'Snooze', exact: true }).click();
      const snoozed = correspondence.locator('details').filter({ hasText: 'Snoozed conversations' });
      const snoozedSummary = snoozed.locator('summary');
      await snoozedSummary.waitFor();
      await assertSingle(visibleLinks.slice(1));
      await snoozedSummary.focus();
      await page.keyboard.press('Enter');
      await snoozed.getByRole('link', { name: 'Workshop logistics' }).waitFor();
      const changeDate = snoozed.getByRole('button', { name: 'Change return date for Workshop logistics' });
      await changeDate.focus();
      await page.keyboard.press('Enter');
      await dateForm.getByLabel('Return date').fill(snoozeDate(8));
      await dateForm.getByRole('button', { name: 'Save date' }).click();
      await snoozed.locator(`time[datetime="${snoozeDate(8)}"]`).waitFor();
      assert.ok(await correspondence.evaluate(node => node.scrollWidth === node.clientWidth));
      await page.screenshot({ path: join(artifacts, `project-correspondence-snoozed-${width}.png`) });
      unread = 2;
      await refresh.click();
      await snoozed.waitFor({ state: 'detached' });
      await correspondence.getByText('1 conversation returned to Active.').waitFor();
      await correspondence.getByText('2 unread', { exact: true }).waitFor();
      await assertSingle(visibleLinks);
      assert.equal(await snooze.count(), 0);
      unread = 0;
      await refresh.click();
      await snooze.waitFor();
      await snooze.click();
      await dateForm.getByLabel('Return date').fill(snoozeDate(9));
      await dateForm.getByRole('button', { name: 'Snooze', exact: true }).click();
      await snoozedSummary.waitFor();
      await snoozedSummary.click();
      await snoozed.getByRole('button', { name: 'Unsnooze Workshop logistics' }).click();
      await snoozed.waitFor({ state: 'detached' });
      await workshop.waitFor();
      unread = -1;
      await refresh.click();
      await correspondence.getByText('Unread status unavailable', { exact: true }).waitFor();
      await assertSingle(visibleLinks);
      unread = 4;
      const beforeRevision = correspondenceReads;
      publish(1);
      await correspondence.getByText('4 unread', { exact: true }).waitFor();
      assert.ok(correspondenceReads > beforeRevision);
      await assertSingle(visibleLinks);
      await page.goBack();
      await page.waitForURL(areaUrl);
      await correspondence.waitFor({ state: 'detached' });
      await link(title).click();
      await correspondence.getByText('4 unread', { exact: true }).waitFor();
      await assertSingle(visibleLinks);
      workshopArchived = true;
      publish(2);
      await summary.getByText('Archived conversations (2)', { exact: true }).waitFor();
      await assertSingle(visibleLinks.slice(1));
      assert.equal(await correspondence.getByText('4 unread', { exact: true }).count(), 0);
      await summary.click();
      await archive.getByRole('link', { name: 'Workshop logistics' }).waitFor();
      assert.equal(await page.evaluate(() => window.duplicateCorrespondence), false);
    } else if (mode === 'create-project') {
      await openLearning();
      await switchArea('Folder');
      await nav.getByText('No projects in this Area yet.').waitFor();
      const add = nav.getByRole('button', { name: 'Add project', exact: true });
      const dialog = nav.getByRole('dialog', { name: 'Add project' });
      const name = dialog.getByRole('textbox', { name: 'Project name' });
      const create = dialog.getByRole('button', { name: 'Create project' });
      await add.focus();
      await page.keyboard.press('Enter');
      await name.waitFor();
      assert.ok(await name.evaluate(element => element.getRootNode().activeElement === element));
      assert.ok(await create.isDisabled());
      await name.fill('../Invalid');
      assert.ok(await create.isDisabled());
      await page.keyboard.press('Escape');
      assert.ok(await add.evaluate(element => element.getRootNode().activeElement === element));
      await add.click();
      await name.fill('Existing');
      await create.click();
      const alert = dialog.getByRole('alert');
      await alert.waitFor();
      assert.match(await alert.innerText(), /already in use/);
      await name.fill('Build a shelf');
      await page.screenshot({ path: join(artifacts, `create-project-dialog-${width}.png`) });
      await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'hidden' });
      await link('Build a shelf').waitFor();
      assert.deepEqual(projectCreations.map(({ source, id, name }) => [source, id, name]),
        [['one', 'Areas/Folder/', 'Existing'], ['one', 'Areas/Folder/', 'Build a shelf']]);
      await add.click();
      await name.fill('Uncertain');
      await create.click();
      await alert.waitFor();
      assert.match(await alert.innerText(), new RegExp(projectCreations[2].operationId));
      assert.equal(await create.count(), 0);
      await page.screenshot({ path: join(artifacts, `create-project-unconfirmed-${width}.png`) });
      await dialog.getByRole('button', { name: 'Close' }).click();
    } else if (mode === 'project-actions') {
      await openLearning();
      const project = link(title);
      const menu = nav.getByLabel(`Actions for project ${title}`);
      const verifyObsidianLink = async (trigger, path, screenshot) => {
        await trigger.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');
        const action = trigger.locator('..').getByRole('button', { name: 'Open in Obsidian' });
        assert.ok(await action.evaluate(el => el.matches(':focus')));
        if (screenshot) await page.screenshot({ path: join(artifacts, `${screenshot}-${width}.png`) });
        await page.keyboard.press('Escape');
        assert.ok(await trigger.evaluate(el => el.matches(':focus')));
        assert.equal(await action.isVisible(), false);
        await page.keyboard.press('Enter');
        if (width === 390) await action.tap();
        else {
          await page.keyboard.press('Tab');
          await page.keyboard.press('Enter');
        }
        const dialog = page.getByRole('dialog', { name: 'Open this obsidian link?' });
        await dialog.getByText(`obsidian://open?vault=Synthetic%20vault&file=${path}`, { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'hidden' });
      };
      await verifyObsidianLink(nav.getByLabel('Actions for Area Learning'), 'Areas%2FLearning.md', 'area-obsidian-menu');
      await verifyObsidianLink(menu, 'Projects%2FLearn%20woodworking.md');
      await project.click();
      await heading(title).waitFor();
      await verifyObsidianLink(menu, 'Projects%2FLearn%20woodworking.md', 'project-obsidian-menu');
      await switchArea('Learning');
      const activate = async name => {
        await menu.focus();
        await page.keyboard.press('Enter');
        const action = menu.locator('..').getByRole('button', { name, exact: true });
        if (width === 390) {
          // Safari can blur the summary without giving focus to the tapped button.
          await action.evaluate(button => button.addEventListener('pointerdown', () => {
            const menu = button.closest('details');
            menu.querySelector('summary').blur();
            window.gtdMenuStayedOpen = menu.open;
          }, { once: true }));
          await action.tap();
          assert.equal(await page.evaluate(() => window.gtdMenuStayedOpen), true, 'The menu must stay open through an in-menu pointer interaction when no element receives focus');
        } else {
          await action.focus();
          await page.keyboard.press('Enter');
        }
      };
      await project.waitFor();
      await activate('Move to Area…');
      const move = nav.getByRole('dialog', { name: 'Move to Area' });
      await move.getByRole('combobox', { name: 'Area' }).selectOption('Areas/Home.md');
      await move.getByRole('button', { name: 'Move', exact: true }).click();
      await nav.getByText('Project assigned locally. iCloud sync is pending.').waitFor();
      assert.deepEqual(projectChanges, [{ kind: 'area', areaPath: 'Areas/Home.md' }]);
      await switchArea('Home');
      await project.waitFor();
      await activate('Mark as done');
      const confirm = nav.getByRole('dialog', { name: 'Mark as done' });
      await confirm.getByText(/archive all its linked BB threads/).waitFor();
      await page.screenshot({ path: join(artifacts, `done-confirm-${width}.png`), timeout: 30000 });
      await confirm.getByRole('button', { name: 'Mark as done', exact: true }).click();
      await nav.getByText('Project moved to Done locally and all linked threads archived.').waitFor();
      assert.deepEqual(projectChanges.at(-1), { kind: 'done' });
      const projectPath = id => `/plugins/gtd/projects/${Buffer.from(JSON.stringify([ref.source, id])).toString('base64url')}`;
      await page.goto(`${base}${projectPath(projectId)}`);
      await heading(title).waitFor();
      await activate('Rename…');
      const rename = nav.getByRole('dialog', { name: 'Rename project' });
      const name = rename.getByRole('textbox', { name: 'Project name' });
      assert.equal(await name.inputValue(), title);
      assert.ok(await name.evaluate(el => el.matches(':focus')));
      await name.fill('Invalid/name');
      assert.ok(await rename.getByRole('button', { name: 'Rename', exact: true }).isDisabled());
      await name.fill('Practice woodworking');
      await page.screenshot({ path: join(artifacts, `rename-project-${width}.png`) });
      await name.press('Enter');
      await page.waitForURL(`**${projectPath('Projects/Done/Practice woodworking.md')}`);
      await heading('Practice woodworking').waitFor();
      assert.deepEqual(projectChanges.at(-1), { kind: 'rename', name: 'Practice woodworking' });
      await switchArea('Learning');
      await nav.getByRole('button', { name: 'New thread for Area Learning' }).click();
      await page.waitForURL('**/threads/fixture1');
      assert.equal(areaCreations[0].id, 'Areas/Learning.md');
    } else if (mode === 'relationships') {
      await openLearning();
      await link('Learn woodworking').waitFor();
      await switchArea('Unassigned area');
      await link('Unresolved project').waitFor();
      await areasCrumb.click();
      await heading('Areas').waitFor();
    } else if (mode === 'area-boundary') {
      await openLearning();
      await link('Learn woodworking').waitFor();
      await switchArea('Empty Area 0');
      await nav.getByText('No projects in this Area yet.').waitFor();
      await switchArea();
      assert.equal(await nav.getByRole('link', { name: /^Empty Area \d$/ }).count(), 8);
    } else if (mode === 'malformed') {
      await nav.getByText('Some projects or Areas could not be loaded. Inventory totals are unconfirmed.').waitFor();
      const details = nav.getByText('Notes with invalid frontmatter');
      await details.focus();
      await page.keyboard.press('Enter');
      await nav.getByText('Projects/Broken.md', { exact: true }).waitFor();
    } else if (mode === 'empty') await nav.getByText('No Areas yet.').waitFor();
    else if (mode === 'error') await nav.getByRole('alert').waitFor();
    else if (mode === 'loading') await nav.getByText('Loading GTD…').waitFor();
    else {
      await nav.getByText('Thread associations', { exact: true }).click();
      await nav.getByText('Unavailable project (2)', { exact: true }).waitFor();
      await page.goto(`${base}/plugins/gtd/projects/${Buffer.from(JSON.stringify([ref.source, 'Projects/Deleted.md'])).toString('base64url')}`);
      await nav.getByText('This project is unavailable in the current inventory.').waitFor();
    }
    assert.equal(await nav.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(artifacts, `${mode}-${width}.png`) });
    console.log(`${mode} ${width}: rendered and checked`); await page.close();
  }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({
    rendered: true, reviewedModes, widths: [1280, 390],
    runtimeReads: ['obsidian.status (empty vaults)', 'obsidian.writeProperties caller refusal before note access', 'gtd.projects (unconfigured)', 'bounded GTD read diagnostic'],
    accountWrites: false, providerRuns: false,
  }));
  console.log(`Evidence: ${artifacts}`);
} catch (error) {
  await copyFile(join(root, 'server.log'), join(artifacts, 'server.log'));
  console.error(`Disposable BB diagnostics: ${artifacts}`);
  throw error;
} finally {
  await browser?.close(); server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 10000))]);
  if (server.exitCode === 0) await rm(root, { recursive: true, force: true }); else console.error('Retained disposable root:', root);
}
