import React, { useId, useState, type ReactNode } from 'react';
import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';

export function FoldableSection({ title, tools, children, className }: {
  title: string;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const heading = useId();
  const content = useId();
  const [expanded, setExpanded] = useState(true);

  return <section className={className} aria-labelledby={heading}>
    <div className="gtd-list-bar gtd-section-header">
      <h2 id={heading}>
        <button type="button" className="gtd-section-toggle" aria-expanded={expanded} aria-controls={content}
          onClick={() => setExpanded(value => !value)}>
          <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} aria-hidden="true" />
          {title}
        </button>
      </h2>
      {expanded && tools}
    </div>
    <div id={content} hidden={!expanded}>{children}</div>
  </section>;
}
