import React, { useEffect, useId, useRef, useState } from 'react';
import { experimental_Icon as Icon, Markdown, useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { z } from 'zod';
import { actionText, actionTextLimit, rpcContract } from './contract.ts';
import { FoldableSection } from './foldable-section.tsx';
import { FilterControls, FilterOption } from './filter-controls.tsx';
import { RowActions } from './row-actions.tsx';

type Snapshot = z.output<typeof rpcContract.readNoteActions.output>;
type Change = z.input<typeof rpcContract.changeNoteAction.input>['change'];
type UndoCompletion = Extract<Change, { operation: 'undoCompletion' }>;
const undoToastDuration = 10_000;
const actionFilters = { open: 'Open', done: 'Done', all: 'All' } as const;
type ActionFilter = keyof typeof actionFilters;

export function NoteActions({ kind, source, id, revision, startingThread, startThread }: z.input<typeof rpcContract.readNoteActions.input> & {
  revision: number;
  startingThread: boolean;
  startThread: (action: { line: number; version: string; refresh: () => void }) => void;
}) {
  const owner = kind === 'area' ? 'Area' : 'project';
  const heading = useId();
  const formId = useId();
  const filterGroup = useId();
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const hasNote = id.endsWith('.md');
  const addButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const mounted = useRef(false);
  const undoToast = useRef<string | number>(undefined);
  const runUndo = useRef<(change: UndoCompletion, event: React.MouseEvent<HTMLButtonElement>) => void>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [filter, setFilter] = useState<ActionFilter>('open');
  const [exiting, setExiting] = useState<{ snapshot: Snapshot; line: number }>();
  const [readState, setReadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<string>();
  const [editTarget, setEditTarget] = useState<{ line: number; version: string; trigger: HTMLElement }>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [uncertainId, setUncertainId] = useState('');
  const editing = draft !== undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (undoToast.current !== undefined) toast.dismiss(undoToast.current);
    };
  }, []);

  useEffect(() => {
    if (!hasNote) return;
    let current = true;
    setReadState('loading');
    void client.current.call('readNoteActions', { kind, source, id }).then(value => {
      if (!current) return;
      setSnapshot(value);
      setReadState('ready');
    }, () => {
      if (current) setReadState('error');
    });
    return () => { current = false; };
  }, [kind, source, id, revision, reload, hasNote]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!exiting) return;
    // Finish even if the browser skips the animation or never reports its end.
    const timer = window.setTimeout(() => setExiting(undefined), 250);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  const refresh = () => {
    setReadState('loading');
    setReload(value => value + 1);
  };
  const closeForm = () => {
    setDraft(undefined);
    setEditTarget(undefined);
    (editTarget?.trigger.isConnected ? editTarget.trigger : addButton.current)?.focus();
  };
  const canWrite = readState === 'ready' && !pending && !uncertainId && !exiting;
  const canChangeRows = canWrite && !editTarget;
  const matchesFilter = (complete: boolean) => filter === 'all' || complete === (filter === 'done');
  const save = async (change: Change, checkbox?: HTMLInputElement) => {
    const undo = change.operation === 'undoCompletion';
    if ((!undo && !canWrite) || saving.current || uncertainId) return;
    saving.current = true;
    setPending(true);
    setError('');
    setNotice('');
    const operationId = crypto.randomUUID();
    try {
      const result = await client.current.call('changeNoteAction', { kind, source, id, change, operationId });
      if (result.outcome === 'saved_locally_pending_sync' || result.outcome === 'unchanged') {
        if (change.operation === 'add') {
          closeForm();
          setNotice('Action added.');
        } else if (!undo && change.text !== undefined) {
          const { line, text } = change;
          setSnapshot(current => current?.version === change.version
            ? { ...current, actions: current.actions.map(action => action.line === line ? { ...action, text } : action) }
            : current);
          closeForm();
          setNotice('Action updated.');
        } else if (!undo && snapshot && change.complete !== undefined) {
          const complete = change.complete;
          if (!matchesFilter(complete)) {
            const row = checkbox?.closest('li');
            if (row?.matches(':focus-within')) {
              const target = row.nextElementSibling?.querySelector('input')
                ?? row.previousElementSibling?.querySelector('input') ?? input.current ?? addButton.current;
              target?.focus();
            }
            setExiting({ snapshot, line: change.line });
          }
          setSnapshot(current => current?.version === change.version
            ? { ...current, actions: current.actions.map(action =>
              action.line === change.line ? { ...action, complete } : action) } : current);
        }
        refresh();
        if (mounted.current && change.operation === 'edit' && 'completionVersion' in result) {
          const reverse = { operation: 'undoCompletion', line: change.line, sectionVersion: result.completionVersion } as const;
          undoToast.current = toast.success('Action marked done', {
            id: undoToast.current,
            duration: undoToastDuration,
            action: { label: 'Undo', onClick: event => runUndo.current?.(reverse, event) },
          });
        }
      } else if (result.outcome === 'uncertain') {
        if (undo) toast.error('Could not confirm whether the action reopened.');
        else if (editTarget) closeForm();
        setUncertainId(operationId);
      } else if (result.outcome === 'not_saved') {
        if (result.reason === 'changed' || result.reason === 'missing_action') {
          if (!undo && editTarget) closeForm();
          if (undo) toast.error('Could not undo completion because the actions changed.');
          else setError(`The ${owner} note changed. Review the latest actions before trying again.`);
          refresh();
        } else {
          if (undo) toast.error('Could not undo completion. Check the TODO section in Obsidian.');
          else setError('Could not save the action. Check the TODO section in Obsidian.');
        }
      }
    } catch {
      if (undo) toast.error('Could not confirm whether the action reopened.');
      else if (editTarget) closeForm();
      setUncertainId(operationId);
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  runUndo.current = (change, event) => {
    if (saving.current || uncertainId) event.preventDefault();
    else if (mounted.current) void save(change);
  };

  const validDraft = actionText.safeParse(draft);
  const actions = (exiting?.snapshot ?? snapshot)?.actions.filter(action => matchesFilter(action.complete)) ?? [];
  const empty = filter === 'done' ? 'No done actions.' : snapshot?.actions.length ? 'No open actions.' : 'No actions recorded.';
  return <FoldableSection title="Actions" className="gtd-note-actions" tools={
    hasNote && <FilterControls label="Action status" action={
      <button type="button" ref={addButton} className="gtd-row-action" aria-label="Add action" title="Add action"
        aria-expanded={editing && !editTarget} aria-controls={editing && !editTarget ? formId : undefined}
        aria-disabled={!canWrite || editing} onClick={() => { if (canWrite && !editing) setDraft(''); }}>
        <Icon name="Plus" aria-hidden="true" />
      </button>
    }>
      {(Object.keys(actionFilters) as ActionFilter[]).map(value =>
        <FilterOption key={value} type="radio" name={filterGroup} label={actionFilters[value]}
          checked={filter === value} disabled={pending || !!exiting || !!editTarget} onChange={() => setFilter(value)} />)}
    </FilterControls>
  }>
    {editing && <form className="gtd-add-action" id={formId} onSubmit={event => {
      event.preventDefault();
      if (!validDraft.success) return;
      void save(editTarget ? { operation: 'edit', line: editTarget.line, version: editTarget.version, text: validDraft.data }
        : { operation: 'add', text: validDraft.data });
    }} onKeyDown={event => {
      if (event.key === 'Escape' && !pending) { event.preventDefault(); closeForm(); }
    }}>
      <input ref={input} aria-label={editTarget ? 'Edit action' : 'Action'} value={draft} onChange={event => setDraft(event.target.value)}
        maxLength={actionTextLimit} readOnly={pending} />
      <div className="gtd-edit-actions">
        <button type="button" disabled={pending} onClick={closeForm}>Cancel</button>
        <button type="submit" aria-disabled={!validDraft.success || !canWrite}>{pending ? 'Saving…' : editTarget ? 'Save' : 'Add'}</button>
      </div>
    </form>}
    {!hasNote ? <p>Add {kind === 'area' ? 'an Area' : 'a project'} note in Obsidian to record actions.</p>
      : readState === 'error' ? <div>
        <p role="status">Could not load actions. Check the {owner} note in Obsidian.</p>
        <button type="button" onClick={refresh}>Try again</button>
      </div>
        : !snapshot ? <p role="status">Loading actions…</p>
          : actions.length ? <ul className="gtd-action-list">
            {actions.map(action => {
              const leaving = exiting?.line === action.line;
              const complete = leaving ? !action.complete : action.complete;
              const label = `${heading}-action-${action.line}`;
              return <li key={action.line} className={leaving ? 'gtd-action-row gtd-action-exiting' : 'gtd-action-row'}
                inert={leaving} data-complete={complete || undefined} data-clickable={canChangeRows || undefined} onClick={event => {
                  if (!canChangeRows || event.defaultPrevented || !(event.target instanceof Element)
                    || event.target.closest('a, button, input, label, details, [role="button"], [role="link"]')) return;
                  const checkbox = event.currentTarget.querySelector<HTMLInputElement>('input[type="checkbox"]');
                  checkbox?.focus({ preventScroll: true });
                  checkbox?.click();
                }} onAnimationEnd={event => {
                  if (leaving && event.target === event.currentTarget) setExiting(undefined);
                }}>
                <div className="gtd-action-content">
                  <label className="gtd-action-checkbox">
                    <input type="checkbox" aria-labelledby={label} checked={complete} aria-disabled={!canChangeRows}
                      onClick={event => { if (!canChangeRows) event.preventDefault(); }}
                      onChange={event => void save({ operation: 'edit', line: action.line, version: snapshot.version, complete: event.target.checked }, event.currentTarget)} />
                  </label>
                  <div className="gtd-note-actions-text" id={label}><Markdown content={action.text} /></div>
                  <RowActions label={`Options for action ${action.text}`} actions={[{
                    label: 'Start a thread', disabled: startingThread || pending || editing || !!exiting || readState !== 'ready',
                    run: () => startThread({ line: action.line, version: snapshot.version, refresh }),
                  }, { label: 'Edit…', disabled: !canWrite || editing, run: trigger => {
                    setEditTarget({ line: action.line, version: snapshot.version, trigger });
                    setDraft(action.text);
                    setError('');
                    setNotice('');
                  } }]} />
                </div>
              </li>;
            })}
          </ul> : <p role="status">{empty}</p>}
    {error && <p role="alert">{error}</p>}
    {uncertainId && <div>
      <p role="alert">Save unconfirmed. Check the refreshed list before trying again. Operation ID <code>{uncertainId}</code></p>
      <button type="button" onClick={() => { setUncertainId(''); refresh(); }}>Reload actions</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </FoldableSection>;
}
