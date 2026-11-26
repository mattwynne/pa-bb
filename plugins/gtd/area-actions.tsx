import React, { useEffect, useId, useRef, useState } from 'react';
import { Markdown, useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { actionText, actionTextLimit, rpcContract } from './contract.ts';

type Snapshot = z.output<typeof rpcContract.readAreaActions.output>;
type Change = z.input<typeof rpcContract.changeAreaAction.input>['change'];

export function AreaActions({ source, id, revision }: { source: string; id: string; revision: number }) {
  const heading = useId();
  const formId = useId();
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const hasNote = id.endsWith('.md');
  const addButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
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
    void client.current.call('readAreaActions', { source, id }).then(value => {
      if (!current) return;
      setSnapshot(value);
      setReadState('ready');
    }, () => {
      if (current) setReadState('error');
    });
    return () => { current = false; };
  }, [source, id, revision, reload, hasNote]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const refresh = () => {
    setReadState('loading');
    setReload(value => value + 1);
  };
  const closeForm = () => {
    setDraft(undefined);
    addButton.current?.focus();
  };
  const canWrite = readState === 'ready' && !pending && !uncertainId;
  const save = async (change: Change) => {
    if (!canWrite || saving.current) return;
    saving.current = true;
    setPending(true);
    setError('');
    setNotice('');
    const operationId = crypto.randomUUID();
    try {
      const result = await client.current.call('changeAreaAction', { source, id, change, operationId });
      if (result.outcome === 'saved_locally_pending_sync' || result.outcome === 'unchanged') {
        if (change.operation === 'add') closeForm();
        setNotice(change.operation === 'add' ? 'Action added.' : change.complete ? 'Action completed.' : 'Action reopened.');
        refresh();
      } else if (result.outcome === 'uncertain') {
        setUncertainId(operationId);
      } else if (result.outcome === 'not_saved') {
        if (result.reason === 'changed' || result.reason === 'missing_action') {
          setError('The Area note changed. Review the latest actions before trying again.');
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
  return <section className="gtd-area-actions" aria-labelledby={heading}>
    <div className="gtd-list-bar">
      <h2 id={heading}>Actions</h2>
      {hasNote && <button type="button" ref={addButton} aria-expanded={editing} aria-controls={editing ? formId : undefined}
        aria-disabled={!canWrite || editing} onClick={() => { if (canWrite && !editing) setDraft(''); }}>
        Add action
      </button>}
    </div>
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
    {!hasNote ? <p>Add an Area note in Obsidian to record actions.</p>
      : readState === 'error' ? <div>
        <p role="status">Could not load actions. Check the Area note in Obsidian.</p>
        <button type="button" onClick={refresh}>Try again</button>
      </div>
        : !snapshot ? <p role="status">Loading actions…</p>
          : snapshot.actions.length ? <ul className="gtd-action-list">
            {snapshot.actions.map(action => <li key={action.line} className="gtd-action-row">
              <label className="gtd-action-checkbox">
                <input type="checkbox" aria-labelledby={`${heading}-action-${action.line}`} checked={action.complete} aria-disabled={!canWrite}
                  onClick={event => { if (!canWrite) event.preventDefault(); }}
                  onChange={event => void save({ operation: 'edit', line: action.line, version: snapshot.version, complete: event.target.checked })} />
              </label>
              <div className="gtd-area-actions-text" id={`${heading}-action-${action.line}`}>
                <Markdown content={action.text} />
              </div>
            </li>)}
          </ul> : <p role="status">No actions recorded.</p>}
    {error && <p role="alert">{error}</p>}
    {uncertainId && <div>
      <p role="alert">Save unconfirmed. Check the refreshed list before trying again. Operation ID <code>{uncertainId}</code></p>
      <button type="button" onClick={() => { setUncertainId(''); refresh(); }}>Reload actions</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
