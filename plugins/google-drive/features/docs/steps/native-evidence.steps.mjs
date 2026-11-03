import{When}from'@cucumber/cucumber';import{fileURLToPath}from'node:url';import{executeBridgeCase}from'../coverage/bridge.mjs';const root=fileURLToPath(new URL('../../../',import.meta.url));
// New compound native invariant case only; global/old step and child limits unchanged.
When('the fixed native production evidence executes {string}',{timeout:30000},async function(caseId){const{pickle,testCaseStartedId}=this.bridgeIdentity,reference=await executeBridgeCase(root,pickle,testCaseStartedId,caseId);await this.attach(JSON.stringify(reference),'application/vnd.pa.docs-evidence+json');});
