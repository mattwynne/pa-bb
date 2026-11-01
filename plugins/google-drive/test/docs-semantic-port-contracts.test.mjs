import test from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createMemorySnapshots } from '../features/docs/support/memory-snapshots.mjs';
import { snapshotContractCases } from '../features/docs/support/snapshot-contract.mjs';
for(const [name,run]of Object.entries(snapshotContractCases())){
  test(`snapshot logical contract memory: ${name}`,()=>run(createMemorySnapshots().port));
  test(`snapshot logical contract actual SQLite: ${name}`,async()=>{const h=createFakePluginHost({pluginId:'semantic-contract'});try{run(createBbStore(h.bb.storage.database(),h.bb.storage.migrate).semanticSnapshots);}finally{await h.harness.lifecycle.dispose();}});
}
