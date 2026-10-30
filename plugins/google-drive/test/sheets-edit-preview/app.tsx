import { useRef, useState } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { SheetsEditApproval } from '../../sheets-edit-approval.js';
import '../../connection-ui.css';
function Review(props: Parameters<typeof SheetsEditApproval>[0]) {
  const failed = useRef<string | undefined>(undefined), [release, setRelease] = useState<(() => void) | null>(null);
  const state = (props.interaction.payload as { reviewState?: string })?.reviewState;
  return <><SheetsEditApproval {...props} submit={async value => {
    if (state === 'error' && failed.current !== props.interaction.id) { failed.current = props.interaction.id; throw Error('Synthetic submission failure'); }
    if (state === 'busy') await new Promise<void>(resolve => setRelease(() => resolve));
    await props.submit(value);
  }} />{release && <button type="button" data-release-synthetic onClick={() => { release(); setRelease(null); }}>Release test submission</button>}</>;
}
export default definePluginApp(app => app.slots.pendingInteraction({ id: 'sheets-edit-approval', component: Review }));
