import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { checkWitnessCase } from '../support/witness-c-checks.mjs';
Given('the C read-evidence interface uses closed GET observations and disposable SQLite',function(){this.cWitnessChecked=false;});
When('the independent C witness pair {string} is compared',async function(kind){await checkWitnessCase(kind);this.cWitnessChecked=true;});
Then('only the concretely supported read witness satisfies coverage',function(){assert.equal(this.cWitnessChecked,true);});
Then('neither comparison grants authoring authority or sends a mutation',function(){assert.equal(this.cWitnessChecked,true);});
