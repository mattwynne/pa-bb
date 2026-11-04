import {useRef} from 'react';
import {definePluginApp} from '@get-bb/plugin-sdk/app';
import {DocsApproval} from '../../docs-approval.js';
import '../../app.css';
import '../../connection-ui.css';
function Review(props: Parameters<typeof DocsApproval>[0]) {
  const failed=useRef(false);
  return <DocsApproval {...props} submit={async value=>{
    if((props.interaction.payload as {reviewState?: string})?.reviewState?.endsWith('error')&&!failed.current){failed.current=true;throw new Error('Synthetic submission failure');}
    await props.submit(value);
  }}/>;
}
export default definePluginApp(app=>app.slots.pendingInteraction({id:'docs-edit-approval',component:Review}));
