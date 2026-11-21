// Actual disposable BB host + built GTD app; all account/thread writes are synthetic.
// Set BB_REVIEW_APP_ROOT to the installed bb-app package, BB_REVIEW_CHROME to Chrome.
import { chromium } from 'playwright';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  await writeFile(refusedInput, JSON.stringify({ vaultId: 'one', path: 'Projects/Woodworking.md', title: 'Synthetic' }), { mode: 0o600 });
  let refused = false;
  try { await cli('plugin', 'rpc', 'call', 'obsidian', 'renameTitle', '--input-file', refusedInput, '--json'); } catch (error) { refused = /forbidden/.test(error.stdout ?? ''); }
  assert.ok(refused, 'Updated title bridge must refuse ordinary clients before note access');
  let unconfigured = false;
  try { await cli('gtd', 'projects', '--json'); } catch (error) { unconfigured = /unconfigured/.test(error.stdout ?? ''); }
  assert.ok(unconfigured, 'Harmless GTD read must fail honestly before vault selection');
  assert.match(await cli('plugin', 'logs', 'gtd', '-n', '5'), /GTD list unconfigured/);
  console.log('Runtime checks: updated Obsidian status and title caller refusal, GTD unconfigured guard and bounded diagnostic verified.');
  const setPreference = (key, value) => cli('settings', 'ui', 'set', key, value);
  await setPreference('sidebar.chronologicalSort', 'updated');
  await setPreference('sidebar.sortDirection', 'ascending');
  console.log(`Evidence: ${artifacts}`);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  for (const width of [1280, 390]) for (const mode of ['normal', 'empty', 'error', 'loading', 'missing', 'directory-gap', 'folder-complete', 'area-boundary']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    page.setDefaultTimeout(12000);
    const errors = []; const consoleErrors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    let title = 'Learn woodworking', area = 'Learning', creations = 0;
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
    await page.route(/\/api\/v1\/threads\?.*archived=true/, route =>
      route.fulfill({ json: [thread('fixture3', 'proj_personal', 'Archived rehearsal', 300, 400)] }));
    await page.route(/\/api\/v1\/threads\/fixture1(?:\?|$)/, route =>
      route.fulfill({ json: thread('fixture1', 'proj_personal', 'Choose tools', 100) }));
    await page.route(/\/api\/v1\/threads\/fixture1\/timeline(?:\?|$)/, route =>
      route.fulfill({ json: {
        rows: [], maxSeq: 0, contextBoundarySeq: null, completedTurnDisplay: 'collapse',
        activePromptMode: null, activeThinking: null, activeWorkflows: [], activeBackgroundCommands: [],
        pendingTodos: null, goal: null, providerCommands: null, sessionOptions: null, modelFallback: null,
        timelinePage: { returnedSegmentCount: 0, olderCursor: null, historySnapshot: 'fixture', olderRowsSourceSeqEnd: null },
      } }));
    await page.route('**/api/v1/threads/plugin-metadata', route => route.fulfill({ json: { threads: ['fixture1', 'fixture2'].map(threadId => ({ threadId, metadata: associations.has(threadId) ? { project: associations.get(threadId) } : {} })) } }));
    await page.route('**/api/v1/plugins/gtd/rpc/**', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1), input = route.request().postDataJSON();
      if (mode === 'loading') { await new Promise(r => setTimeout(r, 15000)); if (page.isClosed()) return; }
      if (mode === 'error') return route.fulfill({ json: { ok: false, error: { code: 'handler_error', message: 'Synthetic failure' } } });
      let result;
      if (method === 'listProjects') result = { source, projects: mode === 'empty' ? [] : [{ id: ref.id, title, status: 'active', areaId: 'Areas/Learning.md' }], coverage: 'complete', warnings: [], totalProjects: mode === 'empty' ? 0 : 1, matchedProjects: 1, counts: { active: 1, deferred: 0, someday: 0, done: 0 }, nextCursor: null, consistency: 'Per-project local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.' };
      if (method === 'listProjects' && mode === 'directory-gap') result = { ...result, projects: [{ id: 'Projects/Folder/', title: 'Folder project', status: 'active' }], coverage: 'partial', warnings: ['directory_enumeration_unavailable'], totalProjects: null, matchedProjects: null, counts: null };
      if (method === 'listProjects' && mode === 'folder-complete') result = { ...result, projects: [{ id: 'Projects/Empty/', title: 'Empty project', status: 'active' }, { id: 'Projects/Attachments/', title: 'Attachment-only project', status: 'active' }], totalProjects: 2, matchedProjects: 2, counts: { active: 2, deferred: 0, someday: 0, done: 0 } };
      if (method === 'listAreas') result = { source, areas: [{ id: 'Areas/Learning.md', title: area }], coverage: 'complete', warnings: [], totalAreas: 1, nextCursor: null, consistency: 'Per-area local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.' };
      if (method === 'listProjects' && mode === 'area-boundary') result.projects[0].areaId = 'Areas/Learning/Example Committee/Meeting.md';
      if (method === 'listAreas' && mode === 'area-boundary') result.areas.push(...Array.from({ length: 8 }, (_, i) => ({ id: `Areas/Empty${i}/`, title: `Empty Area ${i}` })));
      if (method === 'renameProject' || method === 'renameArea') { if (method === 'renameProject') title = input.title; else area = input.title; result = { operationId: '12345678-1234-4123-8123-123456789abc', outcome: 'saved_locally_pending_sync' }; }
      if (method === 'newThread') { creations++; await new Promise(r => setTimeout(r, 250)); result = { threadId: 'fixture1' }; }
      if (method === 'associate') { if (input.project) associations.set(input.threadId, input.project); else associations.delete(input.threadId); result = null; }
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.goto(base);
    const skip = page.getByRole('button', { name: 'Skip setup', exact: true });
    const entry = page.getByRole('button', { name: /^Personal GTD projects(?: \(.*\))?$/ });
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
      await page.waitForURL('**/plugins/gtd/projects');
      await nav.waitFor();
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `host-failure-${width}.png`) });
      console.error('Host diagnostics:', errors, consoleErrors, await page.locator('body').innerText());
      throw error;
    }
    if (mode === 'normal') {
      await nav.getByRole('button', { name: 'Learn woodworking', exact: true }).waitFor();
      await nav.getByRole('link').filter({ hasText: 'Choose tools' }).waitFor();
      assert.equal(await nav.getByRole('link').count(), 2);
      const plus = nav.getByRole('button', { name: 'New thread for Learn woodworking' }); await page.keyboard.press('Tab'); await plus.focus();
      await page.screenshot({ path: join(artifacts, `focus-${width}.png`) });
      assert.notEqual(await plus.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      if (width === 390) assert.ok(await plus.evaluate(el => el.getBoundingClientRect().height >= 44));
      await page.screenshot({ path: join(artifacts, `hierarchy-${width}.png`) });
      page.on('dialog', dialog => dialog.accept(dialog.message().includes('area') ? 'Skills' : 'Woodwork'));
      for (const [kind, name] of [['area', 'Learning'], ['project', 'Learn woodworking']]) {
        await nav.getByLabel(`Actions for ${kind} ${name}`).click();
        const menu = nav.getByLabel(`Actions for ${kind} ${name}`).locator('..'); await menu.getByRole('button', { name: 'Rename' }).click();
        await nav.getByRole('button', { name: kind === 'area' ? 'Skills' : 'Woodwork', exact: true }).waitFor();
      }
      assert.equal(await nav.getByRole('link').count(), 2);
      // Native thread action submenu is the association/reassignment/unlink surface.
      await nav.getByRole('button', { name: 'Actions for Choose tools' }).click();
      await page.getByRole('menuitem', { name: /GTD project/ }).click();
      await page.getByRole('menuitem', { name: 'No GTD project', exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `association-${width}.png`) });
      await page.getByRole('menuitem', { name: 'No GTD project', exact: true }).click();
      await nav.getByText('Unassigned threads (1)', { exact: true }).waitFor();
      await nav.getByText('Unassigned threads (1)', { exact: true }).click();
      await nav.getByRole('button', { name: 'Actions for Choose tools' }).click();
      await page.getByRole('menuitem', { name: /GTD project/ }).click();
      await page.getByRole('menuitem', { name: 'Woodwork', exact: true }).click();
      await nav.getByText('Unassigned threads (0)', { exact: true }).waitFor();
      await nav.getByRole('link', { name: 'Choose tools', exact: true }).click();
      await page.waitForURL('**/threads/fixture1');
      await page.getByTestId('app-page-header-content-row').getByText('Choose tools', { exact: true }).waitFor();
      await nav.waitFor({ state: 'hidden' });
      await openSidebar();
      await assertSavedSort();
      await entry.click();
      await nav.getByRole('button', { name: 'Woodwork', exact: true }).waitFor();
      await page.reload();
      await nav.getByRole('button', { name: 'Woodwork', exact: true }).waitFor();
      const create = nav.getByRole('button', { name: 'New thread for Woodwork' }); await create.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await page.waitForURL('**/threads/fixture1');
      assert.equal(creations, 1);
    } else if (mode === 'area-boundary') {
      await nav.getByRole('button', { name: 'Learning', exact: true }).waitFor();
      await nav.getByRole('button', { name: 'Learn woodworking', exact: true }).waitFor();
      assert.equal(await nav.getByRole('button', { name: 'Empty Area 0', exact: true }).count(), 0);
      assert.equal(await nav.getByText('No active projects', { exact: true }).count(), 0);
      const all = nav.getByRole('button', { name: 'Show all Areas', exact: true }); await all.focus();
      await page.screenshot({ path: join(artifacts, `areas-active-${width}.png`) });
      await page.keyboard.press('Enter');
      const empty = nav.getByRole('button', { name: 'Empty Area 0', exact: true }); await empty.waitFor();
      assert.equal(await empty.getAttribute('aria-expanded'), 'false');
    } else if (mode === 'folder-complete') {
      await nav.getByRole('button', { name: 'Empty project', exact: true }).waitFor();
      await nav.getByRole('button', { name: 'Attachment-only project', exact: true }).waitFor();
      assert.equal(await nav.getByText(/Partial inventory/).count(), 0);
      await nav.getByRole('button', { name: 'New thread for Empty project' }).focus();
    } else if (mode === 'directory-gap') {
      await nav.getByText(/Obsidian cannot enumerate directories/).waitFor();
      await nav.getByLabel('Actions for project Folder project').click();
      assert.equal(await nav.getByLabel('Actions for project Folder project').locator('..').getByRole('button', { name: 'Rename' }).isDisabled(), true);
      await page.keyboard.press('Escape');
      await nav.getByRole('button', { name: 'New thread for Folder project' }).focus();
    } else if (mode === 'empty') await nav.getByText('No matching projects').waitFor();
    else if (mode === 'error') await nav.getByRole('alert').waitFor();
    else if (mode === 'loading') await nav.getByText('Loading GTD…').waitFor();
    else await nav.getByText('Unavailable project (2)', { exact: true }).waitFor();
    assert.equal(await nav.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(artifacts, `${mode}-${width}.png`) });
    console.log(`${mode} ${width}: rendered and checked`); await page.close();
  }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ rendered: true, runtimeReads: ['obsidian.status (empty vaults)', 'obsidian.renameTitle caller refusal before note access', 'gtd.projects (unconfigured)', 'bounded GTD read diagnostic'], accountWrites: false, providerRuns: false, fixture: 'Learning > Learn woodworking > two active threads and one archived BB thread', threadList: ['Automatic', 'saved updated-time sort', 'Organize', 'Filter and archived thread', 'retired explicit provider and recovery'] }));
  console.log(`Evidence: ${artifacts}`);
} finally {
  await browser?.close(); server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 10000))]);
  if (server.exitCode === 0) await rm(root, { recursive: true, force: true }); else console.error('Retained disposable root:', root);
}
