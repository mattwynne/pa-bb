import type { FormEvent } from 'react';

export function PasteBack({ callback, busy, onChange, onSubmit }: { callback: string; busy: boolean; onChange(value: string): void; onSubmit(event: FormEvent): void }) {
  return <form onSubmit={onSubmit} autoComplete="off">
    <p>If your browser cannot open localhost, copy the entire failed localhost redirect address from its address bar and paste it here. This address contains a one-use code: do not paste it into chat or logs.</p>
    <label htmlFor="fastmail-callback">Localhost callback URL</label>
    <input id="fastmail-callback" type="password" autoComplete="off" spellCheck={false} value={callback} onChange={event => onChange(event.target.value)} />
    <button disabled={busy || !callback} type="submit">Complete connection</button>
  </form>;
}
