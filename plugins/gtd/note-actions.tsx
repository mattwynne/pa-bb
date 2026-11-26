import React, { useEffect, useId, useRef, useState } from 'react';
import { experimental_Icon as Icon, Markdown, useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { actionText, actionTextLimit, rpcContract } from './contract.ts';
import { FoldableSection } from './foldable-section.tsx';
import { FilterControls, FilterOption } from './filter-controls.tsx';

type Snapshot = z.output<typeof rpcContract.readNoteActions.output>;
type Change = z.input<typeof rpcContract.changeNoteAction.input>['change'];
const actionFilters = { open: 'Open', done: 'Done', all: 'All' } as const;
type ActionFilter = keyof typeof actionFilters;

export function NoteActions({ kind, source, id, revision }: z.input<typeof rpcContract.readNoteActions.input> & { revision: number }) {
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
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [filter, setFilter] = useState<ActionFilter>('open');
  const [exiting, setExiting] = useState<{ snapshot: Snapshot; line: number }>();
  const [readState, setReadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<string>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [uncertainId, setUncertainId] = useState('');
  const editing = draft !== undefined;

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
    addButton.current?.focus();
  };
  const canWrite = readState === 'ready' && !pending && !uncertainId && !exiting;
  const matchesFilter = (complete: boolean) => filter === 'all' || complete === (filter === 'done');
  const save = async (change: Change, checkbox?: HTMLInputElement) => {
    if (!canWrite || saving.current) return;
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
        } else if (snapshot && change.complete !== undefined) {
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
      } else if (result.outcome === 'uncertain') {
        setUncertainId(operationId);
      } else if (result.outcome === 'not_saved') {
        if (result.reason === 'changed' || result.reason === 'missing_action') {
          setError(`The ${owner} note changed. Review the latest actions before trying again.`);
          refresh();
        } else {
          setError('Could not save the action. Check the TODO section in Obsidian.');
        }
      }
    } catch {
      setUncertainId(operationId);
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  const validDraft = actionText.safeParse(draft);
  const actions = (exiting?.snapshot ?? snapshot)?.actions.filter(action => matchesFilter(action.complete)) ?? [];
  const empty = filter === 'done' ? 'No done actions.' : snapshot?.actions.length ? 'No open actions.' : 'No actions recorded.';
  return <FoldableSection title="Actions" className="gtd-note-actions" tools={
    hasNote && <FilterControls label="Action status" action={
      <button type="button" ref={addButton} className="gtd-row-action" aria-label="Add action" title="Add action"
        aria-expanded={editing} aria-controls={editing ? formId : undefined}
        aria-disabled={!canWrite || editing} onClick={() => { if (canWrite && !editing) setDraft(''); }}>
        <Icon name="Plus" aria-hidden="true" />
      </button>
    }>
      {(Object.keys(actionFilters) as ActionFilter[]).map(value =>
        <FilterOption key={value} type="radio" name={filterGroup} label={actionFilters[value]}
          checked={filter === value} disabled={pending || !!exiting} onChange={() => setFilter(value)} />)}
    </FilterControls>
  }>
    {editing && <form className="gtd-add-action" id={formId} onSubmit={event => {
      event.preventDefault();
      if (validDraft.success) void save({ operation: 'add', text: validDraft.data });
    }}>
      <input ref={input} aria-label="Action" value={draft} onChange={event => setDraft(event.target.value)}
        maxLength={actionTextLimit} readOnly={pending} />
      <div className="gtd-edit-actions">
        <button type="button" disabled={pending} onClick={closeForm}>Cancel</button>
        <button type="submit" aria-disabled={!validDraft.success || !canWrite}>{pending ? 'Saving…' : 'Add'}</button>
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
                inert={leaving} data-complete={complete || undefined} data-clickable={canWrite || undefined} onClick={event => {
                  if (!canWrite || event.defaultPrevented || !(event.target instanceof Element)
                    || event.target.closest('a, button, input, label, summary, [role="button"], [role="link"]')) return;
                  const checkbox = event.currentTarget.querySelector<HTMLInputElement>('input[type="checkbox"]');
                  checkbox?.focus({ preventScroll: true });
                  checkbox?.click();
                }} onAnimationEnd={event => {
                  if (leaving && event.target === event.currentTarget) setExiting(undefined);
                }}>
                <div className="gtd-action-content">
                  <label className="gtd-action-checkbox">
                    <input type="checkbox" aria-labelledby={label} checked={complete} aria-disabled={!canWrite}
                      onClick={event => { if (!canWrite) event.preventDefault(); }}
                      onChange={event => void save({ operation: 'edit', line: action.line, version: snapshot.version, complete: event.target.checked }, event.currentTarget)} />
                  </label>
                  <div className="gtd-note-actions-text" id={label}><Markdown content={action.text} /></div>
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
