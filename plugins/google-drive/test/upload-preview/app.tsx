import { useRef } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { UploadApproval } from '../../upload-approval.js';
import '../../app.css';
import '../../connection-ui.css';
function Review(props: Parameters<typeof UploadApproval>[0]) { const failed = useRef(false); return <UploadApproval {...props} submit={async value => { if ((props.interaction.payload as { reviewState?: string })?.reviewState === 'error' && !failed.current) { failed.current = true; throw new Error('Synthetic failure'); } await props.submit(value); }} />; }
export default definePluginApp(app => app.slots.pendingInteraction({ id: 'drive-upload-approval', component: Review }));
