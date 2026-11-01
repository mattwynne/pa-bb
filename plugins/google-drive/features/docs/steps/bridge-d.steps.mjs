import { Before, When } from '@cucumber/cucumber';
import { fileURLToPath } from 'node:url';
import { executeBridgeCase } from '../coverage/bridge.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
Before({tags:'@bridgeCandidate or @bridgeExecution'},function({pickle,testCaseStartedId}) {
  this.bridgeIdentity={pickle,testCaseStartedId};
});
When('the offline production bridge executes {string}',async function(caseId) {
  const {pickle,testCaseStartedId}=this.bridgeIdentity;
  const reference=await executeBridgeCase(root,pickle,testCaseStartedId,caseId);
  await this.attach(JSON.stringify(reference),'application/vnd.pa.docs-evidence+json');
});
