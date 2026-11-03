// Isolated test/preview composition only. Not imported by serving app.tsx.
import {definePluginApp} from '@get-bb/plugin-sdk/app';
import {DocsReplacementApproval} from './docs-replacement-approval.js';
export default definePluginApp(app=>{app.slots.pendingInteraction({id:'docs-replacement-approval',component:DocsReplacementApproval});});
