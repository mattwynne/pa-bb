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
const nativeStable = process.env.BB_REVIEW_MODE === 'native-stable';
const native = nativeStable || process.env.BB_REVIEW_MODE === 'native-refresh';
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
const cliWithStdin = async (input, ...args) => {
  const running = exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 120000 });
  running.child.stdin.end(input);
  return (await running).stdout;
};
let browser;
const ref = { source: 'one', id: 'Projects/Learn woodworking.md' };
const source = { backend: 'obsidian', id: 'one', name: 'Synthetic vault', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null };
const projectNote = (legacyTitle, status = 'active') => `---\ntitle: ${legacyTitle}\nstatus: ${status}\narea: Areas/Learning.md\n---\n`;
async function connectSyntheticVault(pkg) {
  for (const directory of ['.obsidian', 'Projects/Done', 'Areas', 'Elsewhere']) await mkdir(join(vault, directory), { recursive: true });
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
  let unconfigured = false;
  try { await cli('gtd', 'projects', '--json'); } catch (error) { unconfigured = /unconfigured/.test(error.stdout ?? ''); }
  assert.ok(unconfigured, 'Harmless GTD read must fail honestly before vault selection');
  assert.match(await cli('plugin', 'logs', 'gtd', '-n', '5'), /GTD list unconfigured/);
  console.log('Runtime checks: Obsidian status and property-write caller refusal, GTD unconfigured guard and bounded diagnostic verified.');
  if (native) await connectSyntheticVault(pkg);
  let stableProject, stableArea;
  if (nativeStable) {
    const nested = 'Areas/Learning/Old records.md';
    await writeFile(join(vault, ref.id), projectNote('Legacy label').replace('Areas/Learning.md', nested));
    const choices = { areaAssignments: [{projectPath:ref.id, expectedDeclaration:nested, targetAreaPath:'Areas/Learning.md'}] };
    const report = JSON.parse(await cliWithStdin(JSON.stringify(choices) + '\n', 'gtd', 'migration-preview', '--json', '--choices-stdin'));
    assert.equal(report.coverage, 'complete');
    assert.equal(report.decisions, 0);
    assert.equal(report.links.length, 0);
    assert.deepEqual(report.rows.find(row => row.kind === 'project').areaDecision,
      {kind:'explicit_assignment',targetPath:'Areas/Learning.md'});
    await writeFile(join(artifacts, 'synthetic-preview.json'), JSON.stringify(report, null, 2) + '\n');
    stableProject = report.rows.find(row => row.kind === 'project').proposedId;
    stableArea = report.rows.find(row => row.kind === 'area').proposedId;
    assert.match(stableProject, /^project-[0-9a-f-]{36}$/);
    assert.match(stableArea, /^area-[0-9a-f-]{36}$/);
    const readiness = JSON.parse(await cli('gtd', 'migration-status', '--plan', report.planId, '--readiness'));
    assert.equal(readiness.state, 'review');
    assert.equal(readiness.readiness.stage, 'legacy_checks_passed');
    await cli('gtd', 'migration-apply', '--plan', report.planId);
    assert.equal(JSON.parse(await cli('gtd', 'migration-status', '--plan', report.planId)).state, 'stable');
    assert.match(await readFile(join(vault, ref.id), 'utf8'), new RegExp(stableProject));
    assert.match(await readFile(join(vault, ref.id), 'utf8'), new RegExp(stableArea));
  }
  // The disposable host has no coding agent to complete first-run onboarding.
  await cli('settings', 'general', 'onboardingCompletedAt', new Date().toISOString());
  const setPreference = (key, value) => cli('settings', 'ui', 'set', key, value);
  await setPreference('sidebar.chronologicalSort', 'updated');
  await setPreference('sidebar.sortDirection', 'ascending');
  console.log(`Evidence: ${artifacts}`);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const modes = ['browser-flow', 'normal', 'empty', 'error', 'loading', 'missing', 'malformed', 'area-boundary', 'relationships', 'project-actions', 'area-standard', 'auto-refresh'];
  const reviewedModes = native ? [nativeStable ? 'native-stable' : 'native-refresh'] : process.env.BB_REVIEW_MODE ? modes.filter(mode => mode === process.env.BB_REVIEW_MODE) : modes;
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
    let assignedArea = 'Areas/Learning.md', projectStatus = 'active', projectId = ref.id;
    const standardSaves = [];
    let standardText = 'Practice weekly.', standardHash = 'a'.repeat(64);
    const standardReads = [];
    let homeStandard = '', firstHomeRead = true;
    const associations = new Map(['fixture1', 'fixture2'].map(id => [id, mode === 'missing' ? { ...ref, id: 'Projects/Deleted.md' } : ref]));
    const thread = (id, projectId, title, updatedAt, archivedAt = null) => ({
      ...makeThreadResponse({ id, projectId, title, updatedAt, archivedAt, createdAt: 1 }),
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
    await page.route(/\/api\/v1\/threads\/fixture1\/timeline(?:\?|$)/, route =>
      route.fulfill({ json: {
        rows: [], maxSeq: 0, contextBoundarySeq: null, completedTurnDisplay: 'collapse',
        activePromptMode: null, activeThinking: null, activeWorkflows: [], activeBackgroundCommands: [],
        pendingTodos: null, goal: null, providerCommands: null, sessionOptions: null, modelFallback: null,
        timelinePage: { returnedSegmentCount: 0, olderCursor: null, historySnapshot: 'fixture', olderRowsSourceSeqEnd: null },
      } }));
    associations.set('fixture3', nativeStable ? {source:'one',id:stableProject} : ref);
    associations.set('fixture4', nativeStable ? {source:'one',id:stableProject} : ref);
    if (nativeStable) associations.set('fixture1', {source:'one',id:stableProject});
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
      if (method === 'browseInventoryV2') {
        inventoryReads++;
        await heldRead;
        if (failInventory) return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic failure' } } });
        const projects = mode === 'empty' ? [] : [{ id: projectId, title, status: projectStatus, areaId: assignedArea }];
        if (extraProject) projects.push(extraProject);
        const areas = [{ id: 'Areas/Learning.md', title: 'Learning' }];
        if (mode === 'empty') areas.length = 0;
        if (mode === 'project-actions' || mode === 'browser-flow') areas.push({ id: 'Areas/Home.md', title: 'Home' });
        if (mode === 'area-standard') areas.push({ id: 'Areas/Home.md', title: 'Home' }, { id: 'Areas/Folder/', title: 'Folder' });
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
          identity: 'legacy', aliases: [],
          projects: { source, projects, complete, warnings: complete ? [] : ['invalid_project'],
            ...(!complete ? { malformedFrontmatter: ['Projects/Broken.md'] } : {}) },
          areas: (input.input ?? input).includeAreas ? { source, areas, complete: true, warnings: [] } : null,
        };
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
      if (method === 'changeProject') {
        projectChanges.push(input.change);
        if (input.change.kind === 'area') {
          assignedArea = input.change.areaPath;
          result = { state: 'assigned', message: 'Project assigned locally. iCloud sync is pending.' };
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
    const link = name => nav.getByRole('link', { name, exact: typeof name === 'string' });
    const breadcrumbs = nav.getByRole('navigation', { name: 'Breadcrumb' });
    const areasCrumb = breadcrumbs.getByRole('link', { name: 'Areas', exact: true });
    const filter = nav.getByLabel('Filter by project status', { exact: true });
    const threadFilter = nav.getByLabel('Filter by thread status', { exact: true });
    const areaPicker = nav.getByRole('combobox', { name: 'Area', exact: true });
    const areaLinks = nav.getByRole('navigation', { name: 'Switch Area' });
    const switchArea = async name => {
      await areaPicker.or(areaLinks).filter({ visible: true }).waitFor();
      if (await areaPicker.isVisible()) await areaPicker.selectOption({ label: name });
      else await areaLinks.getByRole('link', { name, exact: true }).click();
      await heading(name === 'All areas' ? 'Areas' : name).waitFor();
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
      await page.screenshot({ path: join(artifacts, `areas-index-${width}.png`) });
      const emptyHref = await link('Empty Area').getAttribute('href');
      await openLearning();
      const areaUrl = page.url();
      assert.equal((await header.boundingBox()).height, indexHeader.height);
      assert.equal((await heading('Learning').boundingBox()).y, indexTitle.y);
      assert.equal(await heading('Learning').evaluate(el => el.matches(':focus')), true);
      assert.equal(await areaPicker.isVisible(), width === 390);
      assert.equal(await areaLinks.isVisible(), width === 1280);
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
      await page.keyboard.press('Tab');
      const newAreaThread = nav.getByRole('button', { name: 'New thread for Area Learning' });
      assert.equal(await newAreaThread.evaluate(el => el.matches(':focus-visible')), true);
      await page.keyboard.press('Tab');
      assert.equal(await nav.getByRole('button', { name: 'Refresh GTD' }).count(), 0);
      assert.equal(await newAreaThread.evaluate(el => el.matches(':focus')), false);
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
    } else if (nativeStable) {
      const route = (panel, id) => `${base}/plugins/gtd/${panel}/${Buffer.from(JSON.stringify(['one', id])).toString('base64url')}`;
      if (width === 1280) {
        await page.goto(route('areas', 'Areas/Learning.md'));
        await heading('Learning').waitFor();
        const linkHref = await link('Learn woodworking').getAttribute('href');
        assert.equal(new URL(linkHref, base).href, route('projects', stableProject));
        await page.goto(route('projects', ref.id));
        await heading('Learn woodworking').waitFor();
        await rename(join(vault, 'Areas/Learning.md'), join(vault, 'Areas/Workshop.md'));
        await rename(join(vault, ref.id), join(vault, 'Projects/New workshop.md'));
        await writeFile(join(vault, ref.id), `---\nid: project-11111111-1111-4111-8111-111111111111\n---\n`);
        await heading('New workshop').waitFor();
        const input = join(root, 'move-project.json');
        await writeFile(input, JSON.stringify({source:'one', id:stableProject, change:{kind:'done'}}));
        const moved = JSON.parse(await cli('plugin', 'rpc', 'call', 'gtd', 'changeProject', '--input-file', input, '--json'));
        if ((moved.result ?? moved).state !== 'done') {
          console.error(await cli('plugin', 'logs', 'gtd', '-n', '10'));
          console.error(await cli('plugin', 'logs', 'obsidian', '-n', '10'));
          console.error('Synthetic destination exists:', await lstat(join(vault, 'Projects/Done/New workshop.md')).then(() => true, () => false));
        }
        assert.equal((moved.result ?? moved).state, 'done', JSON.stringify(moved));
        assert.match(await readFile(join(vault, 'Projects/Done/New workshop.md'), 'utf8'), new RegExp(stableProject));
      }
      await page.goto(route('projects', stableProject));
      await heading('New workshop').waitFor();
      await link('Workshop').waitFor();
      await link('Choose tools').waitFor();
      await threadFilter.click();
      await nav.getByRole('checkbox', {name:'Archived'}).click();
      await page.keyboard.press('Escape');
      await link('Archived rehearsal').waitFor();
      await page.goto(route('projects', ref.id));
      await heading('New workshop').waitFor();
      await page.goto(route('areas', 'Areas/Learning.md'));
      await heading('Workshop').waitFor();
      await nav.getByText('Practice weekly.').waitFor();
      await nav.getByRole('button', {name:'Edit standard'}).focus();
      await page.keyboard.press('Enter');
      await nav.getByRole('textbox', {name:'Standard'}).waitFor();
      await nav.getByRole('button', {name:'Cancel'}).click();
      await page.goto(route('areas', stableArea));
      await heading('Workshop').waitFor();
    } else if (native) {
      await openLearning();
      await link('Learn woodworking').focus();
      await page.waitForResponse(async response =>
        response.url().endsWith('/rpc/inventoryRevision') && typeof (await response.json()).result === 'string');
      assert.equal(await link('Legacy label').count(), 0);
      await writeFile(join(vault, ref.id), projectNote('Edited in vault', 'someday'));
      await link('Learn woodworking').waitFor({ state: 'hidden' });
      assert.ok(await heading('Learning').evaluate(el => el.matches(':focus')));
      await filter.click();
      await nav.getByRole('radio', { name: 'Someday' }).click();
      await page.keyboard.press('Escape');
      await link('Learn woodworking').waitFor();
      assert.equal(await link('Edited in vault').count(), 0);
      await writeFile(join(vault, ref.id), projectNote('Edited in vault'));
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
      await switchArea('All areas');
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
    } else if (mode === 'area-standard') {
      const standard = nav.getByRole('region', { name: 'Standard' });
      await nav.getByRole('link', { name: 'Learning', exact: true }).click();
      await standard.getByText('Practice weekly.', { exact: true }).waitFor();
      const edit = standard.getByRole('button', { name: 'Edit standard' });
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
      await switchArea('All areas');
      assert.equal(await standard.count(), 0);
      assert.ok(!standardReads.includes('Areas/Folder/'));
      assert.equal(standardSaves.length, 4);
    } else if (mode === 'project-actions') {
      await openLearning();
      const project = link(title);
      const menu = nav.getByLabel(`Actions for project ${title}`);
      const activate = async name => {
        await menu.focus();
        await page.keyboard.press('Enter');
        await menu.locator('..').getByRole('button', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
      };
      await project.waitFor();
      if (width === 1280) {
        await project.locator('..').dragTo(areaLinks.getByRole('link', { name: 'Home', exact: true }));
      } else {
        await activate('Move to Area…');
        const dialog = nav.getByRole('dialog', { name: 'Move to Area' });
        await dialog.getByRole('combobox', { name: 'Area' }).selectOption('Areas/Home.md');
        await dialog.getByRole('button', { name: 'Move', exact: true }).click();
      }
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
      if (await areaPicker.isVisible()) await areaPicker.selectOption({ label: 'All areas' });
      else await areaLinks.getByRole('link', { name: 'All areas' }).click();
      await heading('Areas').waitFor();
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
