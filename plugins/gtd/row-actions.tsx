import React from 'react';
import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { useDisclosure } from './filter-controls.tsx';

export type RowAction = { label: string; disabled?: boolean; run: (trigger: HTMLElement) => void };

export function RowActions({ label, projectKey, actions }: {
  label: string; projectKey?: string; actions: RowAction[];
}) {
  const { detailsProps, trigger, close } = useDisclosure();
  return <details className="gtd-menu" {...detailsProps}>
    <summary className="gtd-row-action" ref={trigger} data-gtd-project-action={projectKey} aria-label={label}><Icon name="MoreHorizontal" aria-hidden="true" /></summary>
    <div className="gtd-menu-items">
      {actions.map(action =>
        <button type="button" key={action.label} disabled={action.disabled} onClick={() => {
          if (!trigger.current) return;
          close();
          action.run(trigger.current);
        }}>{action.label}</button>)}
    </div>
  </details>;
}
