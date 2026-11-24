// Actual disposable BB host + built GTD app; all account/thread writes are synthetic.
// Set BB_REVIEW_APP_ROOT to the installed bb-app package, BB_REVIEW_CHROME to Chrome.
import { chromium } from 'playwright';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
const fd = openSync(join(root, 'server.log'), 'w', 0o600);
const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] }); closeSync(fd);
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 120000 })).stdout;
let browser;
const ref = { source: 'one', id: 'Projects/Woodworking.md' };
const source = { backend: 'obsidian', id: 'one', name: 'Synthetic vault', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null };
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
  // The disposable host has no coding agent to complete first-run onboarding.
  await cli('settings', 'general', 'onboardingCompletedAt', new Date().toISOString());
  const setPreference = (key, value) => cli('settings', 'ui', 'set', key, value);
  await setPreference('sidebar.chronologicalSort', 'updated');
  await setPreference('sidebar.sortDirection', 'ascending');
  console.log(`Evidence: ${artifacts}`);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const modes = ['browser-flow', 'normal', 'empty', 'error', 'loading', 'missing', 'malformed', 'area-boundary', 'relationships', 'project-actions'];
  const reviewedModes = process.env.BB_REVIEW_MODE ? modes.filter(mode => mode === process.env.BB_REVIEW_MODE) : modes;
  assert.ok(reviewedModes.length, 'Unknown BB_REVIEW_MODE');
  for (const width of [1280, 390]) for (const mode of reviewedModes) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    page.setDefaultTimeout(12000);
    const errors = []; const consoleErrors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    let title = 'Learn woodworking', creations = 0;
    const projectChanges = [], areaCreations = [];
    let assignedArea = 'Areas/Learning.md', projectStatus = 'active', projectId = ref.id;
    const renames = [];
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
      await route.fulfill({ response, json: value });
    });
    await page.route(/\/api\/v1\/threads\?.*archived=true/, route => {
      const params = new URL(route.request().url()).searchParams;
      if (Number(params.get('offset')) > 0) return route.fulfill({ json: [thread('fixture4', 'proj_personal', 'Earlier rehearsal', 10, 20)] });
      const archived = [thread('fixture3', 'proj_personal', 'Archived rehearsal', 300, 400)];
      if (mode === 'browser-flow') for (let i = 1; i < Number(params.get('limit')); i++) {
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
    associations.set('fixture3', ref);
    associations.set('fixture4', ref);
    await page.route('**/api/v1/threads/plugin-metadata', route => route.fulfill({
      json: { threads: route.request().postDataJSON().threadIds.map(threadId => ({
        threadId, metadata: associations.has(threadId) ? { project: associations.get(threadId) } : {},
      })) },
    }));
    await page.route('**/api/v1/plugins/gtd/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1), input = route.request().postDataJSON();
      if (mode === 'loading') { await new Promise(r => setTimeout(r, 15000)); if (page.isClosed()) return; }
      if (mode === 'error') return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic failure' } } });
      let result;
      if (method === 'browseInventory') {
        const projects = mode === 'empty' ? [] : [{ id: projectId, title, status: projectStatus, areaId: assignedArea }];
        const areas = [{ id: 'Areas/Learning.md', title: 'Learning' }];
        if (mode === 'empty') areas.length = 0;
        if (mode === 'project-actions' || mode === 'browser-flow') areas.push({ id: 'Areas/Home.md', title: 'Home' });
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
      if (method === 'renameProject') {
        renames.push(input);
        title = input.title;
        result = { operationId: '12345678-1234-4123-8123-123456789abc', outcome: 'saved_locally_pending_sync' };
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
          projectId = 'Projects/Done/Woodworking.md';
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
    const filter = nav.getByText('Filter', { exact: true });
    const areaPicker = nav.getByRole('combobox', { name: 'Area', exact: true });
    const areaLinks = nav.getByRole('navigation', { name: 'Switch Area' });
    const switchArea = async name => {
      await areaPicker.or(areaLinks).filter({ visible: true }).waitFor();
      if (await areaPicker.isVisible()) await areaPicker.selectOption({ label: name });
      else await areaLinks.getByRole('link', { name, exact: true }).click();
      await heading(name).waitFor();
    };
    const openLearning = async () => {
      const learning = link('Learning');
      await learning.focus();
      await page.keyboard.press('Enter');
      await heading('Learning').waitFor();
    };
    if (mode === 'browser-flow') {
      await heading('Areas').waitFor();
      await page.screenshot({ path: join(artifacts, `areas-index-${width}.png`) });
      const emptyHref = await link('Empty Area').getAttribute('href');
      await openLearning();
      const areaUrl = page.url();
      assert.equal(await heading('Learning').evaluate(el => el.matches(':focus')), true);
      assert.equal(await areaPicker.isVisible(), width === 390);
      assert.equal(await areaLinks.isVisible(), width === 1280);
      await link('Learn woodworking').waitFor();
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
      await filter.focus();
      await page.keyboard.press('Enter');
      const active = nav.getByRole('checkbox', { name: 'Active' });
      const archived = nav.getByRole('checkbox', { name: 'Archived' });
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
      assert.equal(await filter.evaluate(el => el.matches(':focus')), true);
      await nav.getByRole('button', { name: 'Show more archived threads' }).click();
      await link('Earlier rehearsal').waitFor();
      await page.screenshot({ path: join(artifacts, `project-archived-${width}.png`) });
      await page.goBack();
      await page.waitForURL(areaUrl);
      await heading('Learning').waitFor();
      await link(/Restore a plane Deferred/).waitFor();
      await page.goForward();
      await heading('Learn woodworking').waitFor();
      await nav.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Learning' }).click();
      await heading('Learning').waitFor();
      await page.goto(new URL(projectHref, base).href);
      await heading('Learn woodworking').waitFor();
      await link('Choose tools').waitFor();
      await page.goto(new URL(emptyHref, base).href);
      await heading('Empty Area').waitFor();
      await nav.getByText('No projects in this Area yet.').waitFor();
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
      assert.equal(await nav.getByRole('button', { name: 'Refresh GTD' }).evaluate(el => el.matches(':focus')), true);
      const plus = nav.getByRole('button', { name: 'New thread for Learn woodworking' });
      await page.keyboard.press('Tab'); await plus.focus();
      assert.notEqual(await plus.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      if (width === 390) assert.ok(await plus.evaluate(el => el.getBoundingClientRect().height >= 44));
      await page.screenshot({ path: join(artifacts, `focus-${width}.png`) });
      const name = 'Learn woodworking', replacement = 'Woodwork';
      const trigger = nav.getByLabel(`Actions for project ${name}`);
      const dialog = nav.getByRole('dialog', { name: 'Rename project' });
      const input = dialog.getByRole('textbox', { name: 'Title' });
      const openEditor = async () => {
        await trigger.focus();
        await page.keyboard.press('Enter');
        const rename = trigger.locator('..').getByRole('button', { name: 'Rename' });
        await rename.focus();
        await page.keyboard.press('Enter');
        await input.waitFor();
        assert.equal(await input.evaluate(el => el.matches(':focus')), true);
        assert.deepEqual(await input.evaluate(el => [el.value, el.selectionStart, el.selectionEnd]), [name, 0, name.length]);
        assert.notEqual(await input.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      };
      await openEditor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 12 && bounds.x + bounds.width <= width - 12);
      if (width === 390) {
        for (const control of [input, dialog.getByRole('button', { name: 'Save' }), dialog.getByRole('button', { name: 'Cancel' })]) {
          assert.ok((await control.boundingBox()).height >= 44);
        }
      }
      await page.screenshot({ path: join(artifacts, `rename-project-${width}.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(el => el.matches(':focus')), true);
      await openEditor();
      await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(renames.length, 0);
      await openEditor();
      await page.keyboard.insertText(replacement);
      await page.keyboard.press('Enter');
      await link(replacement).waitFor();
      const updatedTrigger = nav.getByLabel(`Actions for project ${replacement}`);
      await updatedTrigger.waitFor();
      assert.equal(await updatedTrigger.evaluate(el => el.matches(':focus')), true);
      assert.deepEqual(renames, [{ ...ref, title: 'Woodwork' }]);
      await link('Woodwork').click();
      const projectUrl = page.url();
      await heading('Woodwork').waitFor();
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
      await nav.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Areas' }).click();
      await heading('Areas').waitFor();
      await nav.getByText('Thread associations', { exact: true }).click();
      await nav.getByText('Unassigned threads (1)', { exact: true }).waitFor();
      await nav.getByText('Unassigned threads (1)', { exact: true }).click();
      await nav.getByRole('button', { name: 'Actions for Choose tools' }).click();
      await page.getByRole('menuitem', { name: /GTD project/ }).click();
      await page.getByRole('menuitem', { name: 'Woodwork', exact: true }).click();
      await nav.getByText('Unassigned threads (0)', { exact: true }).waitFor();
      await link('Learning').click();
      await link('Woodwork').click();
      await link('Choose tools').click();
      await page.waitForURL('**/threads/fixture1');
      await page.getByTestId('app-page-header-content-row').getByText('Choose tools', { exact: true }).waitFor();
      await nav.waitFor({ state: 'hidden' });
      await openSidebar();
      await assertSavedSort();
      await page.goto(projectUrl);
      await heading('Woodwork').waitFor();
      await page.reload();
      await heading('Woodwork').waitFor();
      const create = nav.getByRole('button', { name: 'New thread for Woodwork' }); await create.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await page.waitForURL('**/threads/fixture1');
      assert.equal(creations, 1);
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
