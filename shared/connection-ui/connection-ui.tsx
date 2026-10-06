// Shared source: run `node scripts/sync-connection-ui.mjs` after changes.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'quiet' };
export function ConnectionButton({ tone = 'quiet', className = '', type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} className={`pa-connection__button pa-connection__button--${tone} ${className}`.trim()} />;
}

export function ConnectionHeading({ title, count, description, action }: { title: string; count?: number; description?: ReactNode; action?: ReactNode }) {
  return <div className="pa-connection__heading">
    <div><h3 className="pa-connection__title">{title}{count !== undefined && <span className="pa-connection__count">{count}</span>}</h3>
      {description && <p className="pa-connection__description">{description}</p>}</div>
    {action}
  </div>;
}

export function ConnectionAccounts({ children }: { children: ReactNode }) {
  return <ul className="pa-connection__accounts">{children}</ul>;
}

export function ConnectionAccount({ initial, label, caption, status, warning = false, action, unavailable = false }: {
  initial: string; label: string; caption?: string; status: string; warning?: boolean; action?: ReactNode; unavailable?: boolean;
}) {
  return <li className="pa-connection__account">
    <span className="pa-connection__avatar" aria-hidden="true">{initial}</span>
    <span className="pa-connection__identity">
      <span className={`pa-connection__account-name${unavailable ? ' pa-connection__account-name--unavailable' : ''}`}>{label}</span>
      {caption && <span className="pa-connection__account-caption">{caption}</span>}
    </span>
    <span className={`pa-connection__badge${warning ? ' pa-connection__badge--warning' : ''}`}>{status}</span>
    {action}
  </li>;
}

export function ConnectionEmpty({ children }: { children: ReactNode }) {
  return <div className="pa-connection__empty">{children}</div>;
}
export function ConnectionAlert({ children }: { children: ReactNode }) {
  return <p className="pa-connection__alert" role="alert">{children}</p>;
}
export function ConnectionFooter({ children }: { children: ReactNode }) {
  return <div className="pa-connection__footer">{children}</div>;
}
export function ConnectionGuide({ href, children = 'Setup guide ↗' }: { href: string; children?: ReactNode }) {
  return <a className="pa-connection__guide" href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
export function ConnectionSetup({ title, children }: { title: string; children: ReactNode }) {
  return <div className="pa-connection__onboarding"><h4>{title}</h4>{children}</div>;
}
export function ConnectionDisclosure({ summary, children, open = false }: { summary: string; children: ReactNode; open?: boolean }) {
  return <details className="pa-connection__disclosure" open={open}><summary>{summary}</summary>{children}</details>;
}
