import test from 'node:test';
import { checkSelectorB } from '../features/docs/support/selectors-b-checks.mjs';
for(const name of ['exact heading text','typed heading level','literal source map','normalization budget','cursor corruption','delivery corruption']) {
  test(`B native read evidence: ${name}`,()=>checkSelectorB(name));
}
