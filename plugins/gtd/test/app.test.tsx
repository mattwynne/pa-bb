// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, cleanup } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const app = await loadPluginApp(() => import('../app.tsx'));
const ref = { source: 'one', id: 'Projects/Woodworking.md' };
const source = { backend: 'fake', id: 'one', name: 'Synthetic', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null };
const project = { id: ref.id, title: 'Learn woodworking', status: 'active', areaId: 'Areas/Learning.md' };
function setup(mode = 'normal', newThread = async () => ({ threadId: 'created' })) {
  const list = renderSlot(app.navPanels[0], { subPath: '' }, {
    rpc: {
      listProjects: async () => { if (mode === 'error') throw new Error('synthetic'); if (mode === 'loading') await new Promise(() => {}); return { source, projects: mode === 'empty' ? [] : [{ ...project, areaId: mode === 'nested' ? 'Areas/Learning/Committee/Meeting.md' : project.areaId }], coverage: 'complete', warnings: [], totalProjects: 1, matchedProjects: 1, counts: { active: 1, deferred: 0, someday: 0, done: 0 }, nextCursor: null, consistency: 'Per-project local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.' }; },
      listAreas: async () => ({ source, areas: [{ id: 'Areas/Learning.md', title: 'Learning' }, ...Array.from({ length: 8 }, (_, i) => ({ id: `Areas/Empty${i}/`, title: `Empty Area ${i}` }))], coverage: 'complete', warnings: [], totalAreas: 1, nextCursor: null, consistency: 'Per-area local observations, not an atomic source snapshot. Sync timestamps do not verify cloud or device delivery.' }),
      newThread, renameProject: async () => ({ operationId: crypto.randomUUID(), outcome: 'saved_locally_pending_sync' }), renameArea: async () => ({ operationId: crypto.randomUUID(), outcome: 'saved_locally_pending_sync' }),
    },
    sdk: { threads: { experimental_listPluginMetadata: async () => ({ threads: [{ threadId: 't1', metadata: { project: ref } }, { threadId: 't2', metadata: { project: ref } }] }) } },
    sidebarThreads: { status: 'ready', threads: ['t1', 't2'].map((id, i) => ({ id, projectId: 'personal', href: '/threads/' + id, displayTitle: 'Woodwork thread ' + i, title: 'Woodwork thread ' + i, titleFallback: '', indicator: 'idle', indicatorLabel: 'Idle', environment: null, isHidden: false, isArchived: false, isUnread: false, activity: {}, status: 'idle' })) as any },
  }); return list;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
test('GTD registers a navigation panel and keeps area, project and thread actions', async () => {
  expect(app.threadLists).toHaveLength(0);
  expect(app.navPanels).toMatchObject([{ id: 'projects', path: 'projects', title: 'Personal GTD projects' }]);
  const slot = setup(); await slot.findByRole('button', { name: 'Learn woodworking' });
  expect(slot.getAllByRole('link')).toHaveLength(2);
  const area = slot.getByRole('button', { name: /Learning/ }); fireEvent.click(area); expect(area.getAttribute('aria-expanded')).toBe('false'); fireEvent.click(area);
  vi.spyOn(window, 'prompt').mockReturnValue('Woodwork'); fireEvent.click(slot.getByLabelText('Actions for project Learn woodworking')); fireEvent.click(slot.getByLabelText('Actions for project Learn woodworking').parentElement!.querySelector('button')!);
  await vi.waitFor(() => expect(slot.inspection.rpcCalls.some(c => c.method === 'renameProject')).toBe(true));
  expect(slot.inspection.rpcCalls.find(c => c.method === 'renameProject')?.input).toEqual({ ...ref, title: 'Woodwork' });
  slot.lifecycle.unmount();
});
test('double activation while pending creates once and navigates through BB', async () => {
  let release!: () => void; const start = vi.fn(async () => { await new Promise<void>(r => { release = r; }); return { threadId: 'created' }; });
  const slot = setup('normal', start); const plus = await slot.findByRole('button', { name: 'New thread for Learn woodworking' });
  fireEvent.click(plus); fireEvent.click(plus); expect(start).toHaveBeenCalledTimes(1); release();
  await vi.waitFor(() => expect(slot.inspection.navigateCalls.some(c => c.method === 'toThread')).toBe(true)); slot.lifecycle.unmount();
});
test('fast completion reuses its request during the double-click window', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const slot = setup();
  fireEvent.click(await slot.findByRole('button', { name: 'New thread for Learn woodworking' }));
  await vi.waitFor(() => expect(slot.inspection.navigateCalls.some(c => c.method === 'toThread')).toBe(true));
  fireEvent.click(await slot.findByRole('button', { name: 'New thread for Learn woodworking' }));
  await vi.waitFor(() => expect(slot.inspection.rpcCalls.filter(c => c.method === 'newThread')).toHaveLength(2));
  const calls = slot.inspection.rpcCalls.filter(c => c.method === 'newThread'); expect(calls[0].input).toEqual(calls[1].input);
  slot.lifecycle.unmount();
});
function associationAction({
  inventoryLoading = false, inventoryError = '', linksLoading = false, linksError = false, threadRequested = true, stored,
}: { inventoryLoading?: boolean; inventoryError?: string; linksLoading?: boolean; linksError?: boolean; threadRequested?: boolean; stored?: unknown } = {}) {
  const call = vi.fn(async () => null);
  const action = app.threadActions[0].item({
    thread: { id: 't1' },
    data: {
      inventory: { loading: inventoryLoading, error: inventoryError, source: ref.source, projects: [project] },
      links: { t1: stored }, error: linksError, loading: linksLoading, threadIds: new Set(threadRequested ? ['t1'] : []), rpc: { call },
    },
  } as any)!;
  return { action, call, run: (value?: string) => action.run({ value, requestRename: vi.fn() }) };
}
test.each([
  { linksLoading: true, message: 'Loading thread association…' },
  { threadRequested: false, message: 'Loading thread association…' },
  { linksError: true, message: 'Thread association could not load' },
  { stored: { id: ref.id }, message: 'Thread association could not load' },
])('thread menu shows unknown metadata as $message and rejects every choice', async ({ message, ...state }) => {
  const { action, call, run } = associationAction(state);
  expect(action.choices?.hint).toContain(message);
  for (const choice of action.choices!.items) {
    expect(choice).toMatchObject({ disabled: true, selected: false });
    await expect(run(choice.id)).rejects.toThrow('choice is unavailable');
  }
  expect(call).not.toHaveBeenCalled();
});
test.each([
  { inventoryLoading: true, message: 'Loading GTD projects…' },
  { inventoryError: 'GTD could not load', message: 'GTD could not load' },
])('thread menu can unlink a known association while inventory shows $message', async ({ message, ...state }) => {
  const { action, call, run } = associationAction({ ...state, stored: ref });
  expect(action.choices?.hint).toContain(message);
  expect(action.choices?.items).toMatchObject([{ id: 'unlink', selected: false, disabled: false }]);
  await expect(run(`project:${project.id}`)).rejects.toThrow('choice is unavailable');
  await run('unlink');
  expect(call).toHaveBeenCalledExactlyOnceWith('associate', { threadId: 't1', project: null });
});
test('thread association choices reflect the exact source and only accept listed projects', async () => {
  const unlinked = associationAction();
  const [unlink, selectProject] = unlinked.action.choices!.items;
  expect(unlink).toMatchObject({ selected: true, disabled: true });
  expect(selectProject).toMatchObject({ selected: false, disabled: false });
  await expect(unlinked.run()).rejects.toThrow('choice is unavailable');
  await expect(unlinked.run('project:missing')).rejects.toThrow('choice is unavailable');
  await unlinked.run(selectProject.id);
  expect(unlinked.call).toHaveBeenCalledExactlyOnceWith('associate', { threadId: 't1', project: ref });
  expect(associationAction({ stored: ref }).action.choices?.items[1].selected).toBe(true);
  const missing = associationAction({ stored: { ...ref, source: 'other' } }).action;
  expect(missing.choices?.hint).toBe('The linked GTD project is unavailable.');
  expect(missing.choices?.items.every(choice => !choice.selected)).toBe(true);
});
test('project and Area menus dismiss outside without stealing focus and consume Escape only while open', async () => {
  const slot = setup();
  await slot.findByRole('button', { name: 'Learn woodworking' });
  const outside = slot.getByRole('button', { name: 'Refresh GTD' });
  const escape = vi.fn();
  document.addEventListener('keydown', escape);
  try {
    for (const label of ['Actions for project Learn woodworking', 'Actions for area Learning']) {
      const trigger = slot.getByLabelText(label);
      const details = trigger.closest('details')!;
      const rename = details.querySelector('button')!;
      trigger.focus();
      fireEvent.click(trigger);
      rename.focus();
      expect(details.open).toBe(true);
      fireEvent.keyDown(rename, { key: 'Escape' });
      expect(details.open).toBe(false);
      expect(document.activeElement).toBe(trigger);
      expect(escape).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(escape).toHaveBeenCalledTimes(1);
      escape.mockClear();

      fireEvent.click(trigger);
      outside.focus();
      expect(details.open).toBe(false);
      expect(document.activeElement).toBe(outside);

      trigger.focus();
      fireEvent.click(trigger);
      fireEvent(details, new Event('toggle'));
      fireEvent.pointerDown(rename);
      expect(details.open).toBe(true);
      fireEvent.pointerDown(outside);
      expect(details.open).toBe(false);
    }
  } finally {
    document.removeEventListener('keydown', escape);
  }
  slot.lifecycle.unmount();
});
test('Active shows only matching Areas; nested IDs roll up without any writes; All discovers empty Areas', async () => {
  const slot = setup('nested');
  await slot.findByRole('button', { name: 'Learning' });
  expect(slot.queryByRole('button', { name: 'Unassigned area' })).toBeNull();
  expect(slot.queryByRole('button', { name: 'Empty Area 0' })).toBeNull();
  expect(slot.queryByText('No active projects')).toBeNull();
  fireEvent.click(slot.getByRole('button', { name: 'Show all Areas' }));
  const empty = await slot.findByRole('button', { name: 'Empty Area 0' });
  expect(empty.getAttribute('aria-expanded')).toBe('false');
  expect(slot.inspection.rpcCalls.every(c => ['listAreas', 'listProjects'].includes(c.method))).toBe(true);
  slot.lifecycle.unmount();
});
test('no matching projects produces one empty state while retaining all-Areas discovery', async () => {
  const slot = setup('empty'); await slot.findByText('No matching projects');
  expect(slot.getAllByText('No matching projects')).toHaveLength(1);
  expect(slot.queryByRole('button', { name: 'Learning' })).toBeNull();
  fireEvent.click(slot.getByRole('button', { name: 'Show all Areas' }));
  expect(await slot.findByRole('button', { name: 'Learning' })).toBeTruthy();
  expect(slot.queryByText('No active projects')).toBeNull(); slot.lifecycle.unmount();
});
for (const mode of ['empty', 'loading', 'error']) test(`${mode} is distinct and recoverable`, async () => {
  const slot = setup(mode);
  if (mode === 'loading') expect(await slot.findByText('Loading GTD…')).toBeTruthy();
  if (mode === 'error') expect(await slot.findByRole('alert')).toBeTruthy();
  if (mode === 'empty') expect(await slot.findByText('No matching projects')).toBeTruthy();
  slot.lifecycle.unmount();
});
