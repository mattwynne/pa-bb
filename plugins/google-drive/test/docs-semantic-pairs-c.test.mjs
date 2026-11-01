import test from 'node:test';
import { witnessCases,checkWitnessCase } from '../features/docs/support/witness-c-checks.mjs';
for(const kind of witnessCases)test(`C independent read-interface pair ${kind}`,()=>checkWitnessCase(kind));
