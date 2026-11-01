import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createBbStore } from './adapters/bb-store.mjs';
import { createGoogleAdapter } from './adapters/google.mjs';
import { registerSemanticReadTools } from './docs-semantic-registration.mjs';
export { SEMANTIC_READ_TOOL_NAMES } from './docs-semantic-schemas.mjs';

// Composition seam exercised by the offline native host. Do not wire into the
// serving factory until the S02 sibling/dependency exposure audit is complete.
export function registerDocsSemanticTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  return registerSemanticReadTools(bb, store, adapter);
}
