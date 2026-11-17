import { useEffect } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { rpcContract, statusSchema } from './contract.ts';
import type { z } from 'zod';
type Attention = NonNullable<z.infer<typeof statusSchema>['attention']>;
export const attentionCopy = (stage: Attention['stage']) => stage === 'authentication'
  ? { title: 'Sign in to iCloud again', description: 'Apple rejected the saved authorization. Reconnect to continue.' }
  : stage === 'provider_rejected'
    ? { title: 'Connection needs attention', description: 'Apple returned HTTP 421. Sign-in may help, but this does not prove authorization expired. Cloud retries are held.' }
    : { title: 'iCloud sign-in reminder', description: 'Apple may ask you to sign in again soon. Reconnect when convenient.' };
const TOAST_ID = 'icloud-connection-attention';
const SETTINGS_HREF = '/plugins/icloud?configure=icloud';
let inlineVisible = false;
export function useInlineAttention() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    const windowId = crypto.randomUUID();
    inlineVisible = true; toast.dismiss(TOAST_ID);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('icloud-settings-attention');
    const presence = () => { if (!document.hidden) channel?.postMessage('inline-visible'); void rpc.call('attentionPresence', { windowId, visible: !document.hidden }).catch(() => {}); };
    presence();
    const timer = setInterval(presence, 15_000);
    document.addEventListener('visibilitychange', presence);
    return () => { inlineVisible = false; channel?.close(); clearInterval(timer); document.removeEventListener('visibilitychange', presence); void rpc.call('attentionPresence', { windowId, visible: false }).catch(() => {}); };
  }, []);
}
// Headless app-wide mount; native Sonner owns chrome, history and announcements.
export function ICloudAttention() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    let disposed = false; let pending = false; let shown: string | null = null; let owned: string | null = null; let presentation = 0;
    const dismiss = () => { presentation++; toast.dismiss(TOAST_ID); shown = null; };
    async function check() {
      if (pending || disposed) return;
      if (inlineVisible || document.hidden || !navigator.onLine) { dismiss(); return; }
      pending = true;
      try {
        const state = await rpc.call('status', null);
        if (disposed || inlineVisible || document.hidden || !navigator.onLine) return;
        const item = state.attention;
        if (!item || item.snoozedUntil || item.inlineVisible) { if (!item || item.snoozedUntil) owned = null; dismiss(); return; }
        if (shown === item.generation) return;
        if (owned !== item.generation && !await rpc.call('attentionAction', { generation: item.generation, action: 'claim' })) { dismiss(); return; }
        owned = item.generation;
        if (disposed || inlineVisible || document.hidden || !navigator.onLine) return;
        shown = item.generation;
        const displayed = ++presentation;
        const ownsPresentation = () => !disposed && presentation === displayed && shown === item.generation && owned === item.generation;
        const eligible = () => ownsPresentation() && !inlineVisible && !document.hidden && navigator.onLine;
        const showFailure = async () => {
          if (!eligible()) return;
          try {
            const current = (await rpc.call('status', null)).attention;
            if (!eligible()) return;
            if (!current || current.generation !== item.generation || current.stage !== item.stage || current.snoozedUntil || current.inlineVisible) {
              void check(); return;
            }
            show(true);
          } catch { /* An unavailable check cannot resurrect last-known attention. */ }
        };
        const copy = attentionCopy(item.stage);
        const show = (failed = false) => toast.warning(copy.title, { id: TOAST_ID, duration: Infinity, dismissible: false,
          description: <>{failed ? 'Could not save the reminder. Try again in' : copy.description}{' '}<a className="pa-connection__guide" href={SETTINGS_HREF}>iCloud settings</a>{failed ? '.' : ''}</>,
          action: { label: 'Open iCloud settings', onClick: () => { window.location.assign(SETTINGS_HREF); } },
          cancel: { label: 'Remind tomorrow', onClick: () => { void rpc.call('attentionAction', { generation: item.generation, action: 'snooze' }).then(saved => { if (saved) { if (ownsPresentation()) { owned = null; dismiss(); } } else void showFailure(); }).catch(() => { void showFailure(); }); } } });
        show();
      } catch { dismiss(); /* Offline checks do not queue notifications or diagnose expiry. */ }
      finally { pending = false; }
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('icloud-settings-attention');
    if (channel) channel.onmessage = event => { if (event.data === 'inline-visible') dismiss(); };
    const first = setTimeout(() => void check(), 500);
    const timer = setInterval(() => void check(), 15_000);
    const changed = () => { void check(); };
    window.addEventListener('online', changed); window.addEventListener('offline', changed); document.addEventListener('visibilitychange', changed);
    return () => { disposed = true; channel?.close(); clearTimeout(first); clearInterval(timer); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); document.removeEventListener('visibilitychange', changed); dismiss(); };
  }, []);
  return null;
}
