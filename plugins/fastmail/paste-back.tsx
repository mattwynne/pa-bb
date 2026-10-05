import type { FormEvent } from 'react';
import { ConnectionButton } from './connection-ui.js';

export function PasteBack({ callback, busy, onChange, onSubmit }: { callback: string; busy: boolean; onChange(value: string): void; onSubmit(event: FormEvent): void }) {
  return <form className="pa-fastmail__paste" onSubmit={onSubmit} autoComplete="off">
    <label htmlFor="fastmail-callback">Address from the failed localhost page</label>
    <p id="fastmail-callback-help">Copy the entire address from your browser’s address bar. It contains a one-use code: paste it only here, never in chat or a support ticket.</p>
    <input id="fastmail-callback" name="fastmail-callback" type="password" maxLength={8192} autoComplete="off" spellCheck={false} aria-describedby="fastmail-callback-help" value={callback} onChange={event => onChange(event.target.value)} />
    <ConnectionButton tone="primary" disabled={busy || !callback.trim()} type="submit">Complete connection</ConnectionButton>
  </form>;
}
