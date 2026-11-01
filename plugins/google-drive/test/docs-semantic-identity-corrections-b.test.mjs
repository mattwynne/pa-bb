import test from 'node:test';
import { checkIdentityCorrectionB } from '../features/docs/support/identity-corrections-b-checks.mjs';
for(const name of ['unique shift','actual duplicate','omitted duplicate','repaired omission','retyped duplicate','invented structure','changed unknown data','orphan','duplicate edge','duplicate path','wrong scope','wrong grid','omitted source','retyped source']) {
  test(`B1 original read-model validation: ${name}`,()=>checkIdentityCorrectionB(name));
}
// Cycle probes run only after validation exists; they are then ordinary bounded
// regressions, never an intentionally hanging pre-fix traversal.
for(const name of ['cycle','cyclic object'])test(`B1 bounded graph validation: ${name}`,()=>checkIdentityCorrectionB(name));
