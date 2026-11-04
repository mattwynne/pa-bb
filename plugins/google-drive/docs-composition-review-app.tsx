// Isolated engineering/preview entry only. NOT imported by serving app.tsx.
import {definePluginApp} from '@get-bb/plugin-sdk/app';
import {DocsCompositionApproval} from './docs-composition-approval.js';
export default definePluginApp(app=>{app.slots.pendingInteraction({id:'docs-composition-approval',component:DocsCompositionApproval});});
