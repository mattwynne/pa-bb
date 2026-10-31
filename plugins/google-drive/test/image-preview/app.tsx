import { useRef } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { DocsImageApproval } from '../../docs-image-approval.js';
import '../../app.css';
import '../../connection-ui.css';
function Review(props: Parameters<typeof DocsImageApproval>[0]) {
  const failed = useRef(false);
  return <DocsImageApproval {...props} submit={async value => {
    const state = (props.interaction.payload as { reviewState?: string })?.reviewState;
    if (state === 'busy') await new Promise(r => setTimeout(r, 1500));
    if (state === 'error' && !failed.current) { failed.current = true; throw new Error('Synthetic failure'); }
    await props.submit(value);
  }} />;
}
export default definePluginApp(app => app.slots.pendingInteraction({ id: 'docs-image-approval', component: Review }));
