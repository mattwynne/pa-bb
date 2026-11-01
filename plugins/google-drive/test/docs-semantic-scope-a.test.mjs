import test from 'node:test';
import { scopeAExample } from '../features/docs/support/scope-a-checks.mjs';
for(const example of ['businessSection','includeHeading','ambiguousHeading','missingEnd','richIntersection','siblingSpan','registryDefinitions','acceptedPreview','rejectedPreview','pagedInspect','emptySection']) {
  test(`continuation A original native read: ${example}`,()=>scopeAExample(example));
}
