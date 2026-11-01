import { Given, Then } from '@cucumber/cucumber';
import { checkIdentityCorrectionB } from '../support/identity-corrections-b-checks.mjs';
Given('the independent B identity correction fixture {string}',function(name){this.identityCorrectionB=name;});
Then('identity comparison validates both original observed models',async function(){await checkIdentityCorrectionB(this.identityCorrectionB);});
