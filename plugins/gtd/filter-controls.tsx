import React, { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';

export function useDisclosure() {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = menu.current;
    if (!open || !details) return;
    const dismissOutside = (event: PointerEvent) => {
      if (details.open && !event.composedPath().includes(details)) details.open = false;
    };
    details.ownerDocument.addEventListener('pointerdown', dismissOutside, true);
    return () => details.ownerDocument.removeEventListener('pointerdown', dismissOutside, true);
  }, [open]);
  const closeAndFocus = (details: HTMLDetailsElement) => {
    details.open = false;
    trigger.current?.focus();
  };
  const detailsProps: React.ComponentPropsWithRef<'details'> = { ref: menu,
    onToggle: event => setOpen(event.currentTarget.open),
    onBlur: event => {
      const details = event.currentTarget;
      // A tap can blur the summary without moving focus to the tapped control.
      // Pointer events handle clicks and taps outside the disclosure.
      if (details.open && event.relatedTarget && !details.contains(event.relatedTarget)) details.open = false;
    },
    onKeyDown: event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus(event.currentTarget);
    },
  };
  return { detailsProps, trigger, close: () => { if (menu.current) closeAndFocus(menu.current); } };
}

export function FilterControls({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  const { detailsProps, trigger } = useDisclosure();
  return <div className="gtd-list-actions">
    <details className="gtd-menu gtd-filter" {...detailsProps}>
      <summary ref={trigger} aria-label={`Filter by ${label.toLowerCase()}`}><Icon name="SlidersHorizontal" aria-hidden="true" />Filter</summary>
      <div className="gtd-menu-items" role="group" aria-label={label}>{children}</div>
    </details>
    {action}
  </div>;
}

export function FilterOption({ type, name, label, checked, disabled, onChange }: {
  type: 'radio' | 'checkbox'; name?: string; label: string; checked: boolean; disabled?: boolean; onChange: () => void;
}) {
  return <label title={type === 'checkbox' && disabled ? 'Keep at least one filter selected' : undefined}>
    <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} />
    {label}{checked && <Icon name="Check" aria-hidden="true" />}
  </label>;
}
