import React, { useEffect, useId, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { rpcContract } from './contract.ts';
import { mailProvider, uniqueConversations, type correspondenceLinks, type MailStatus } from './core/correspondence.ts';

const refreshInterval = 5 * 60_000;
const statuses = {
  unsupported: 'Unread status unavailable for this link',
  account_missing: 'Mailbox unavailable',
  account_mismatch: 'Link is for a different Fastmail account',
  not_found: 'Conversation not found',
  incomplete: 'Mailbox returned incomplete conversation data',
  unavailable: 'Unread status unavailable',
};

export function ProjectCorrespondence({ source, id, revision }: { source: string; id: string; revision: number }) {
  const heading = useId();
  const client = useRpc<typeof rpcContract>();
  const rpc = useRef(client);
  rpc.current = client;
  const [links, setLinks] = useState<z.infer<typeof correspondenceLinks>>();
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
        setLinks(saved);
        setReadError(false);
        const rows = saved.links.length ? await rpc.current.call('readCorrespondenceStatus', { source, id }) : [];
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
      {(!!links?.links.length || readError) && <button type="button" aria-disabled={busy} onClick={() => refresh.current()}>Refresh email</button>}
    </div>
    {readError && <p role="status">Correspondence could not refresh. Check the project note in Obsidian.</p>}
    {!links && !readError && <p role="status">Loading correspondence…</p>}
    {links?.incomplete && <p role="status">Some correspondence entries could not be read. Use one subject link per bullet in Obsidian.</p>}
    {links && !links.links.length && !links.incomplete && <p>No email conversations linked.</p>}
    {!!links?.links.length && <ul className="gtd-rows">
      {uniqueConversations(links.links, mail).map(({ title, url }) => {
        const provider = mailProvider(url);
        const status = mail.get(url);
        return <li key={url} className="gtd-correspondence-row">
          {provider ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : <span>{title}</span>}
          <span className="gtd-correspondence-detail">
            {!provider ? 'Unsupported email link'
              : status?.status === 'ok' ? <>
                {status.unread > 0 && <strong>{status.unread} unread</strong>}
                {status.sender && <span>{status.sender}</span>}
                {status.latestAt && <time dateTime={status.latestAt}>{new Date(status.latestAt).toLocaleDateString()}</time>}
              </> : status ? statuses[status.status] : busy ? 'Checking mail…' : 'Unread status unavailable'}
          </span>
        </li>;
      })}
    </ul>}
  </section>;
}
