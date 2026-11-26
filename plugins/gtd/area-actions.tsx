import React, { useEffect, useId, useRef, useState } from 'react';
import { Markdown, useRpc } from '@get-bb/plugin-sdk/app';
import { rpcContract } from './contract.ts';

export function AreaActions({ source, id, revision }: { source: string; id: string; revision: number }) {
  const heading = useId();
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const hasNote = id.endsWith('.md');
  const [result, setResult] = useState<{ text: string } | 'error'>();

  useEffect(() => {
    if (!hasNote) return;
    let current = true;
    void client.current.call('readAreaActions', { source, id }).then(value => {
      if (current) setResult(value);
    }, () => {
      if (current) setResult('error');
    });
    return () => { current = false; };
  }, [source, id, revision, hasNote]);

  return <section className="gtd-area-actions" aria-labelledby={heading}>
    <h2 id={heading}>Actions</h2>
    {!hasNote ? <p>Add an Area note in Obsidian to record actions.</p>
      : result === 'error' ? <p role="status">Could not load actions. Check the Area note in Obsidian.</p>
        : result?.text.trim() ? <Markdown className="gtd-area-actions-text" content={result.text} />
          : <p role="status">{result ? 'No actions recorded.' : 'Loading actions…'}</p>}
  </section>;
}
