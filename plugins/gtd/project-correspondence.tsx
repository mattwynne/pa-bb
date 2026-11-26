import React, { useEffect, useId, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { rpcContract, type correspondenceChange } from './contract.ts';
import { correspondenceDate, mailProvider, uniqueConversations, type correspondenceLinks, type projectCorrespondence, type MailStatus } from './core/correspondence.ts';

const refreshInterval = 5 * 60_000;
const statuses = {
  unsupported: 'Unread status unavailable for this link',
  account_missing: 'Mailbox unavailable',
  account_mismatch: 'Link is for a different Fastmail account',
  not_found: 'Conversation not found',
  incomplete: 'Mailbox returned incomplete conversation data',
  unavailable: 'Unread status unavailable',
};

type Change = z.infer<typeof correspondenceChange>;
type Row = z.infer<typeof correspondenceLinks>['links'][number] & { returnDate?: string };
const dateLabel = (date: string) => new Date(date + 'T00:00:00Z').toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const blocked = {
  not_listed: 'The conversation moved. Refresh email and try again.',
  archived: 'Archived conversations cannot be snoozed.',
  unread: 'Read the unread messages before snoozing this conversation.',
  mail_unavailable: 'The mailbox could not confirm zero unread messages. Refresh email and try again.',
  invalid_section: 'Check the correspondence sections in Obsidian for formatting or size limits.',
  date_due: 'Choose a return date after today.',
};

function ConversationRows({ links, mail, busy, onChange }: {
  links: Row[]; mail?: ReadonlyMap<string, MailStatus>; busy?: boolean;
  onChange?: (url: string, change: Change) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string>();
  return <ul className="gtd-rows">
    {(mail ? uniqueConversations(links, mail) : links).map(({ title, url, returnDate }) => {
      const provider = mailProvider(url);
      const status = mail?.get(url);
      return <li key={url} className="gtd-correspondence-row">
        {provider ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : <span>{title}</span>}
        {(!provider || mail) && <span className="gtd-correspondence-detail">
          {!provider ? 'Unsupported email link'
            : status?.status === 'ok' ? <>
              {status.unread > 0 && <strong>{status.unread} unread</strong>}
              {status.sender && <span>{status.sender}</span>}
              {status.latestAt && <time dateTime={status.latestAt}>{new Date(status.latestAt).toLocaleDateString()}</time>}
            </> : status ? statuses[status.status] : busy ? 'Checking mail…' : 'Unread status unavailable'}
        </span>}
        {returnDate && <span className="gtd-correspondence-detail">Returns <time dateTime={returnDate}>{dateLabel(returnDate)}</time></span>}
        {onChange && (returnDate || (provider && status?.status === 'ok' && status.unread === 0)) && <div className="gtd-correspondence-controls">
          {provider && (editing === url ? <form aria-label={`Return date for ${title}`} onSubmit={async event => {
            event.preventDefault();
            if (busy) return;
            const date = new FormData(event.currentTarget).get('returnDate');
            if (typeof date === 'string' && await onChange(url, { kind: 'snooze', returnDate: date }))
              setEditing(undefined);
          }}>
            <label>Return date <input type="date" name="returnDate" autoFocus required defaultValue={returnDate}
              min={correspondenceDate(Date.now() + 24 * 60 * 60_000)} /></label>
            <button type="submit" disabled={busy}>{returnDate ? 'Save date' : 'Snooze'}</button>
            <button type="button" onClick={() => setEditing(undefined)}>Cancel</button>
          </form> : <button type="button" aria-label={`${returnDate ? 'Change return date for' : 'Snooze'} ${title}`}
            disabled={busy} onClick={() => setEditing(url)}>{returnDate ? 'Change date' : 'Snooze'}</button>)}
          {returnDate && <button type="button" aria-label={`Unsnooze ${title}`} disabled={busy}
            onClick={() => { void onChange(url, { kind: 'unsnooze' }); }}>Unsnooze</button>}
        </div>}
      </li>;
    })}
  </ul>;
}

export function ProjectCorrespondence({ source, id, revision }: { source: string; id: string; revision: number }) {
  const heading = useId();
  const client = useRpc<typeof rpcContract>();
  const rpc = useRef(client);
  rpc.current = client;
  const [conversations, setConversations] = useState<z.infer<typeof projectCorrespondence>>();
  const [mail, setMail] = useState<Map<string, MailStatus>>(new Map());
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [snoozedMailIncomplete, setSnoozedMailIncomplete] = useState(false);
  const editing = useRef(false);
  const unconfirmedRefresh = useRef(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async (explicit = false) => {
      if (pending || editing.current || (!explicit && unconfirmedRefresh.current) || document.visibilityState === 'hidden') return;
      pending = true;
      setBusy(true);
      try {
        const saved = await rpc.current.call('readCorrespondence', { source, id });
        if (!active) return;
        setConversations(saved);
        setReadError(false);
        const result = saved.active.links.length || saved.snoozed.links.length ? await rpc.current.call('refreshCorrespondence', { source, id }) : null;
        if (active) {
          setMail(new Map(result?.mail.map(row => [row.url, row.mail])));
          setSnoozedMailIncomplete(result?.snoozedMailIncomplete ?? false);
          if (result) {
            setConversations(result.correspondence);
            unconfirmedRefresh.current = result.receipt?.outcome === 'uncertain';
            if (unconfirmedRefresh.current && result.receipt)
              setFeedback(`Return to Active could not be confirmed. Check the Obsidian receipt ${result.receipt.operationId}.`);
            else if (result.receipt?.outcome === 'not_saved')
              setFeedback('Could not return conversations to Active. Check the project note and refresh email.');
            else if (result.returned.length)
              setFeedback(`${result.returned.length} ${result.returned.length === 1 ? 'conversation returned' : 'conversations returned'} to Active.`);
          }
        }
      } catch {
        if (active) { setReadError(true); setMail(new Map()); }
      } finally {
        pending = false;
        if (active) setBusy(false);
      }
    };
    const onFocus = () => { void load(); };
    refresh.current = () => { void load(true); };
    void load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const interval = window.setInterval(onFocus, refreshInterval);
    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(interval);
    };
  }, [source, id, revision]);

  const change = async (url: string, edit: Change) => {
    if (editing.current || busy) return false;
    editing.current = true;
    setSaving(true);
    setFeedback('');
    const operationId = crypto.randomUUID();
    let saved = false;
    try {
      const result = await rpc.current.call('changeCorrespondenceSnooze', { source, id, url, change: edit, operationId });
      if (result.state === 'blocked') setFeedback(blocked[result.reason]);
      else if (result.state === 'uncertain') setFeedback(`The change could not be confirmed. Check the Obsidian receipt ${operationId}.`);
      else if (result.state === 'not_saved') setFeedback('The change could not be saved. Check the project note and refresh email.');
      else {
        saved = true;
        setFeedback(edit.kind === 'snooze' ? `Snoozed until ${dateLabel(edit.returnDate)}.` : 'Conversation returned to Active.');
      }
    } catch { setFeedback(`The change could not be confirmed. Check the Obsidian receipt ${operationId}.`); }
    finally {
      editing.current = false;
      setSaving(false);
      if (saved) refresh.current();
    }
    return saved;
  };

  return <section className="gtd-linked" aria-labelledby={heading}>
    <div className="gtd-list-bar">
      <h2 id={heading}>Correspondence</h2>
      {(!!conversations?.active.links.length || !!conversations?.snoozed.links.length || readError) &&
        <button type="button" aria-disabled={busy || saving} onClick={() => refresh.current()}>Refresh email</button>}
    </div>
    {readError && <p role="status">Correspondence could not refresh. Check the project note in Obsidian.</p>}
    {feedback && <p role="status">{feedback}</p>}
    {!conversations && !readError && <p role="status">Loading correspondence…</p>}
    {conversations && <>
      <h3 className="gtd-correspondence-heading">Active conversations</h3>
      {conversations.active.incomplete && <p role="status">Some active conversations could not be read. Check the links in Obsidian.</p>}
      {conversations.active.links.length
        ? <ConversationRows links={conversations.active.links} mail={mail} busy={busy || saving} onChange={change} />
        : !conversations.active.incomplete && <p className="gtd-empty">No active conversations.</p>}
      {(!!conversations.snoozed.links.length || conversations.snoozed.incomplete) && <details className="gtd-correspondence-archive">
        <summary>Snoozed conversations{!conversations.snoozed.incomplete && ` (${conversations.snoozed.links.length})`}</summary>
        {conversations.snoozed.incomplete && <p role="status">Some snoozed conversations could not be read. Check the links in Obsidian.</p>}
        {snoozedMailIncomplete && <p role="status">Unread status is unavailable for some snoozed conversations. Their return dates still apply.</p>}
        {!!conversations.snoozed.links.length && <ConversationRows links={conversations.snoozed.links} busy={busy || saving} onChange={change} />}
      </details>}
      <details className="gtd-correspondence-archive">
        <summary>Archived conversations{!conversations.archived.incomplete && ` (${conversations.archived.links.length})`}</summary>
        {conversations.archived.incomplete && <p role="status">Some archived conversations could not be read. Check the links in Obsidian.</p>}
        {conversations.archived.links.length
          ? <ConversationRows links={conversations.archived.links} />
          : !conversations.archived.incomplete && <p className="gtd-empty">No archived conversations.</p>}
      </details>
    </>}
  </section>;
}
