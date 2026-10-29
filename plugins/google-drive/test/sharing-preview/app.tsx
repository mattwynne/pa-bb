import { useRef, useState } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { SharingApproval } from '../../sharing-approval.js';
import '../../app.css';
import '../../connection-ui.css';
function Review(props: Parameters<typeof SharingApproval>[0]) {
  const failed = useRef<string | undefined>(undefined);
  const [release, setRelease] = useState<(() => void) | null>(null);
  const state = (props.interaction.payload as { reviewState?: string })?.reviewState;
  return <><SharingApproval {...props} submit={async value => {
    if (state === 'error' && failed.current !== props.interaction.id) { failed.current = props.interaction.id; throw new Error('Synthetic submit failure'); }
    if (state === 'busy') await new Promise<void>(resolve => setRelease(() => resolve));
    await props.submit(value);
  }} />{release && <button type="button" data-release-synthetic onClick={() => { release(); setRelease(null); }}>Release test submission</button>}</>;
}
export default definePluginApp(app => app.slots.pendingInteraction({ id: 'drive-sharing-approval', component: Review }));
