import assert from 'node:assert/strict';
import { When,Then } from '@cucumber/cucumber';
import { correctionExample } from '../support/a-correction-checks.mjs';
When('the offline A correction example {string} is checked',async function(example){
  await correctionExample(example);this.aCorrectionChecked=true;
});
Then('the original A correction expectation is satisfied',function(){assert.equal(this.aCorrectionChecked,true);});
