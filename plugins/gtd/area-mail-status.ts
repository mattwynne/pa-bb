import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import { rpcContract } from './contract.ts';
import type { areaMailStatus } from './core/correspondence.ts';

type Selection = z.input<typeof rpcContract.readAreaMailStatus.input>;
type Row = z.infer<typeof areaMailStatus>[number];
const refreshInterval = 5 * 60_000;

export function useAreaMailStatus(source: string, areaId: Selection['areaId'] | undefined, status: Selection['status'],
  revision: number, hasProjects: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const scope = areaId === undefined ? undefined : JSON.stringify([source, areaId, status, revision]);
  const [result, setResult] = useState<{ scope: string; rows: Map<string, Row['state']> }>();

  useEffect(() => {
    if (areaId === undefined || !scope || !source || !hasProjects) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const rows = await client.current.call('readAreaMailStatus', { source, areaId, status });
        if (active) setResult({ scope, rows: new Map(rows.map(row => [row.id, row.state])) });
      } catch {
        if (active) setResult({ scope, rows: new Map() });
      } finally { pending = false; }
    };
    const onVisible = () => { void refresh(); };
    onVisible();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, refreshInterval);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [source, areaId, status, scope, hasProjects]);

  return result && result.scope === scope ? result.rows : undefined;
}
