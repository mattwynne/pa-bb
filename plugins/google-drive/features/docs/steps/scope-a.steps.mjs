import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';
import { scopeAExample } from '../support/scope-a-checks.mjs';
When('continuation A read example {string} runs through the actual application with substituted external ports', async function(example) {
  await scopeAExample(example);
  this.scopeACompared=true;
});
Then('continuation A returned the independent original-content expectation', function() {
  assert.equal(this.scopeACompared,true);
});
