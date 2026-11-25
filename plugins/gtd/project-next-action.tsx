import React, { useEffect, useId, useRef, useState } from 'react';
import { Markdown, useRpc } from '@get-bb/plugin-sdk/app';
import { rpcContract } from './contract.ts';

export function ProjectNextAction({ source, id, revision }: { source: string; id: string; revision: number }) {
  const heading = useId();
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const [result, setResult] = useState<{ text: string | null } | 'error'>();

  useEffect(() => {
    let current = true;
    void client.current.call('readNextAction', { source, id }).then(result => {
      if (current) setResult(result);
    }, () => {
      if (current) setResult('error');
    });
    return () => { current = false; };
  }, [source, id, revision]);

  return <section className="gtd-next-action" aria-labelledby={heading}>
    <h2 id={heading}>Next action</h2>
    {result === 'error' ? <p role="status">Could not load the next action. Check the project note in Obsidian.</p>
      : result?.text ? <Markdown className="gtd-next-action-text" content={result.text} />
        : <p role="status">{result ? 'No next action recorded.' : 'Loading next action…'}</p>}
  </section>;
}
