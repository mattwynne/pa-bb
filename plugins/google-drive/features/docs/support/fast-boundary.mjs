// Enforced pure-core boundary. Builtin aliases are normalized before checking.
import {registerHooks} from 'node:module';
const denied=new Set(['child_process','cluster','worker_threads','sqlite','http','https','http2','net','tls','dgram','dns','dns/promises']);
registerHooks({resolve(specifier,context,next){
 const builtin=specifier.replace(/^node:/,'');
 if(denied.has(builtin)||/(?:@get-bb\/plugin-sdk|better-sqlite3|production-host\.mjs|semantic-world\.mjs|docs-semantic-store\.mjs|bb-store\.mjs)/.test(specifier))throw new Error(`Fast test crossed external-system boundary: ${specifier}`);
 return next(specifier,context);
}});
globalThis.fetch=()=>{throw new Error('Unexpected network in fast semantic test');};
