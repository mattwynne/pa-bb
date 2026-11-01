import { Given, Then } from '@cucumber/cucumber';
import { checkSelectorB } from '../support/selectors-b-checks.mjs';
Given('the independent B read fixture for {string}',function(name){this.selectorBCase=name;});
Then('the B native selector and stored evidence agree with the independent facts',async function(){await checkSelectorB(this.selectorBCase);});
