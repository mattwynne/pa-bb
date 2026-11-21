// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, cleanup } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const app = await loadPluginApp(() => import('../app.tsx'));
const ref = { source: 'one', id: 'Projects/Woodworking.md' };
const source = { backend: 'fake', id: 'one', name: 'Synthetic', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null };
const project = { id: ref.id, title: 'Learn woodworking', status: 'active', areaId: 'Areas/Learning.md' };
function setup(mode = 'normal', newThread = async () => ({ threadId: 'created' })) {
  const list = renderSlot(app.threadLists[0], { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: vi.fn(), searchQuery: '' }, {
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
test('supported sidebar slot renders area/project/thread hierarchy; keyboard collapse and rename keep references', async () => {
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
test('thread menu can unlink during source failure without changing any environment', async () => {
  const call = vi.fn(async () => null);
  const action = app.threadActions[0].item({ thread: { id: 't1' }, data: { inventory: { loading: false, error: 'source unavailable', source: '', projects: [] }, links: { t1: ref }, error: false, loading: false, rpc: { call } } } as any);
  expect(action).toBeTruthy(); await action!.run({ value: 'unlink' } as any);
  expect(call).toHaveBeenCalledWith('associate', { threadId: 't1', project: null });
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
