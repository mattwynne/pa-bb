import assert from 'node:assert/strict';
import { When,Then } from '@cucumber/cucumber';
import { containerCases,checkContainerNative } from '../support/a-container-checks.mjs';
When('the offline typed-container example {string} is read',async function(id){
  const c=containerCases.find(c=>c.id===id);assert.ok(c,'known original example');
  await checkContainerNative(c);this.typedContainerChecked=true;
});
Then('the original typed-container expectation is satisfied',function(){assert.equal(this.typedContainerChecked,true);});
