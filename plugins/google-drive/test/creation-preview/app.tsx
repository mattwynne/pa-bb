import { useRef } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { CreationApproval } from '../../creation-approval.js';
import '../../app.css';
import '../../connection-ui.css';
function Review(props: Parameters<typeof CreationApproval>[0]) { const failed = useRef(false); return <CreationApproval {...props} submit={async value => { if ((props.interaction.payload as { reviewState?: string })?.reviewState === 'error' && !failed.current) { failed.current = true; throw new Error('Synthetic failure'); } await props.submit(value); }} />; }
export default definePluginApp(app => app.slots.pendingInteraction({ id: 'drive-creation-approval', component: Review }));
