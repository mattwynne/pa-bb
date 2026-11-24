import React, { useEffect, useId, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { rpcContract, standardTextLimit } from './contract.ts';

type Version = { text: string; hash: string };

export function AreaStandard({ source, id }: { source: string; id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const label = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
  const pending = useRef(false);
  const [load, reload] = useState(0);
  const [version, setVersion] = useState<Version>();
  const [readError, setReadError] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<'changed' | 'invalid_section' | 'not_saved' | 'uncertain'>();
  const [receipt, setReceipt] = useState('');

  useEffect(() => {
    if (!id.endsWith('.md')) return;
    let current = true;
    void client.current.call('readAreaStandard', { source, id }).then(value => {
      if (current) setVersion({ ...value, text: value.text.replace(/\r\n/g, '\n') });
    }, () => { if (current) setReadError(true); });
    return () => { current = false; };
  }, [source, id, load]);

  const editing = draft !== undefined;
  useEffect(() => {
    if (editing) editor.current?.focus();
    if (!editing && version && restoreFocus.current) {
      restoreFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing, version]);

  const readAgain = () => {
    setReadError(false);
    setVersion(undefined);
    reload(value => value + 1);
  };
  const closeEditor = () => {
    restoreFocus.current = true;
    setFailure(undefined);
    setDraft(undefined);
  };
  const save = async () => {
    if (!version || draft === undefined || draft === version.text || pending.current || failure === 'changed' || failure === 'uncertain') return;
    const operationId = crypto.randomUUID();
    pending.current = true;
    setSaving(true);
    setFailure(undefined);
    try {
      const result = await client.current.call('saveAreaStandard', { source, id, text: draft, expectedHash: version.hash, operationId });
      if (result.outcome === 'saved_locally_pending_sync') {
        closeEditor();
        setNotice('Standard saved locally in Obsidian.');
        readAgain();
      } else if (result.outcome === 'not_saved') {
        setFailure(result.reason ?? 'not_saved');
      } else {
        setReceipt(operationId);
        setFailure('uncertain');
      }
    } catch {
      setReceipt(operationId);
      setFailure('uncertain');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return <section className="gtd-standard" aria-labelledby={label}>
    <div className="gtd-list-bar">
      <h2 id={label}>Standard</h2>
      {version && !editing && <button type="button" ref={editButton} onClick={() => {
        setNotice('');
        setDraft(version.text);
      }}>{version.text ? 'Edit standard' : 'Add standard'}</button>}
    </div>
    {!id.endsWith('.md') ? <p className="gtd-standard-hint">Add an Area note in Obsidian to set a standard.</p>
      : readError ? <div>
        <p role="alert">Could not read the standard. Check the Area note in Obsidian.</p>
        <button type="button" onClick={readAgain}>Try again</button>
      </div> : !version ? <p role="status" className="gtd-standard-hint">Loading standard…</p>
        : editing ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <textarea aria-labelledby={label} ref={editor} value={draft} rows={5} maxLength={standardTextLimit} readOnly={saving}
            onChange={event => setDraft(event.target.value)} />
          {failure === 'changed' && <p role="alert">The Area note changed in Obsidian. Copy your draft if needed, then load the current standard.</p>}
          {failure === 'invalid_section' && <p role="alert">Obsidian could not save this section. Check for duplicate Standard headings or headings in the draft that start a new section.</p>}
          {failure === 'not_saved' && <p role="alert">The standard was not saved. Check that the Area note is available in Obsidian.</p>}
          {failure === 'uncertain' && <p role="alert">The save is unconfirmed. Check the Obsidian receipt before trying again. Operation ID <code>{receipt}</code></p>}
          <div className="gtd-title-actions">
            {failure === 'changed' ? <button type="button" onClick={() => { closeEditor(); readAgain(); }}>Load current standard</button>
              : <button type="button" disabled={saving || failure === 'uncertain'} onClick={closeEditor}>Cancel</button>}
            <button type="submit" disabled={saving || draft === version.text || failure === 'changed' || failure === 'uncertain'}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form> : version.text ? <p className="gtd-standard-text">{version.text}</p>
          : <p className="gtd-standard-hint">No standard set.</p>}
    {notice && <p role="status" className="gtd-standard-hint">{notice}</p>}
  </section>;
}
