import React, { useEffect, useId, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { rpcContract } from './contract.ts';
import { mailProvider, uniqueConversations, type correspondenceLinks, type projectCorrespondence, type MailStatus } from './core/correspondence.ts';

const refreshInterval = 5 * 60_000;
const statuses = {
  unsupported: 'Unread status unavailable for this link',
  account_missing: 'Mailbox unavailable',
  account_mismatch: 'Link is for a different Fastmail account',
  not_found: 'Conversation not found',
  incomplete: 'Mailbox returned incomplete conversation data',
  unavailable: 'Unread status unavailable',
};

function ConversationRows({ links, mail, busy }: {
  links: z.infer<typeof correspondenceLinks>['links']; mail?: ReadonlyMap<string, MailStatus>; busy?: boolean;
}) {
  return <ul className="gtd-rows">
    {(mail ? uniqueConversations(links, mail) : links).map(({ title, url }) => {
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
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      setBusy(true);
      try {
        const saved = await rpc.current.call('readCorrespondence', { source, id });
        if (!active) return;
        setConversations(saved);
        setReadError(false);
        const rows = saved.active.links.length ? await rpc.current.call('readCorrespondenceStatus', { source, id }) : [];
        if (active) setMail(new Map(rows.map(row => [row.url, row.mail])));
      } catch {
        if (active) { setReadError(true); setMail(new Map()); }
      } finally {
        pending = false;
        if (active) setBusy(false);
      }
    };
    const onFocus = () => { void load(); };
    refresh.current = onFocus;
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

  return <section className="gtd-linked" aria-labelledby={heading}>
    <div className="gtd-list-bar">
      <h2 id={heading}>Correspondence</h2>
      {(!!conversations?.active.links.length || readError) && <button type="button" aria-disabled={busy} onClick={() => refresh.current()}>Refresh email</button>}
    </div>
    {readError && <p role="status">Correspondence could not refresh. Check the project note in Obsidian.</p>}
    {!conversations && !readError && <p role="status">Loading correspondence…</p>}
    {conversations && <>
      <h3 className="gtd-correspondence-heading">Active conversations</h3>
      {conversations.active.incomplete && <p role="status">Some active conversations could not be read. Check the links in Obsidian.</p>}
      {conversations.active.links.length
        ? <ConversationRows links={conversations.active.links} mail={mail} busy={busy} />
        : !conversations.active.incomplete && <p className="gtd-empty">No active conversations.</p>}
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
