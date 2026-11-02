import {When} from '@cucumber/cucumber';
import {fileURLToPath} from 'node:url';
import {executeBridgeCase} from '../coverage/bridge.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
When('the fixed no-write production evidence executes {string}',async function(caseId){const {pickle,testCaseStartedId}=this.bridgeIdentity;const reference=await executeBridgeCase(root,pickle,testCaseStartedId,caseId);await this.attach(JSON.stringify(reference),'application/vnd.pa.docs-evidence+json');});
