// Enforced fast-test boundary, not an author-supplied evidence label.
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){
  if(/(?:@get-bb\/plugin-sdk|better-sqlite3|node:child_process|production-host\.mjs|semantic-world\.mjs|docs-semantic-store\.mjs|bb-store\.mjs)/.test(specifier))throw new Error(`Fast test crossed external-system boundary: ${specifier}`);
  return next(specifier,context);
}});
globalThis.fetch=()=>{throw new Error('Unexpected network in fast semantic test');};
