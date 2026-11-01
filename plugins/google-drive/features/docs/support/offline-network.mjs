// Process-local safety net for the sequential offline native host. This is not
// a malicious-code sandbox. Known Google traffic uses the explicit fixture port;
// accidental ambient HTTP/DNS/socket access fails even if its error is caught.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
export function closeAmbientNetwork() {
  const restores=[],faults=[];
  const replace=(object,key)=>{
    const original=object[key];
    if(typeof original!=='function')return;
    object[key]=()=>{faults.push(key);throw new Error('Ambient network is forbidden in the offline bridge');};
    restores.push(()=>{object[key]=original;});
  };
  replace(globalThis,'fetch');
  for(const module of [http,https])for(const key of ['request','get'])replace(module,key);
  for(const module of [dns,dns.promises])for(const key of Object.keys(module))if(key==='lookup'||key==='lookupService'||key.startsWith('resolve')||key==='reverse')replace(module,key);
  for(const module of [net,tls])for(const key of ['connect','createConnection'])replace(module,key);
  replace(net.Socket.prototype,'connect');
  syncBuiltinESMExports();
  return ()=>{
    try {assert.deepEqual(faults,[],'unacknowledged ambient network fault');}
    finally {for(const restore of restores.reverse())restore();syncBuiltinESMExports();}
  };
}
