import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Obsidian } from '../core/service.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { MoveLinkError } from '../core/move.ts';
import { VaultError, type VaultFiles } from '../core/ports.ts';
import { FilesFake, CatalogFake, MemoryState, hash } from './fakes.ts';
class MoveFiles extends FilesFake {
 physical: Array<{outcome:'moved_locally_pending_sync'}>=[]; moves=0;
 async move(i: Parameters<NonNullable<VaultFiles['move']>>[0]) {
  this.moves++;const key=i.mirrorId+'/'+i.path, dest=i.mirrorId+'/'+i.destination, text=this.notes.get(key);
  if(text===undefined||hash(text)!==i.expectedHash||this.notes.has(dest))throw new VaultError('conflict');
  this.notes.set(dest,text);this.notes.delete(key);this.physical=[{outcome:'moved_locally_pending_sync'}];return this.physical[0];
 }
 async moveReceipts(){return this.physical;}
}
async function fixture(clock = Date.now){
 const files=new MoveFiles();files.notes.clear();files.notes.set('one/Areas/Example.md','body\n');files.notes.set('one/Index.md','[[Example#Heading|alias]]\n');
 const state=new MemoryState(), catalog=new CatalogFake(), logs:string[]=[];
 const make=()=>new Obsidian(catalog,files,new MarkdownNotes(),state,randomUUID,clock,(s,c)=>logs.push(s+':'+c));
 const service=make();await service.start();await service.connect('one');
 const source=await service.read({vaultId:'one',path:'Areas/Example.md'},undefined,'reader');
 return{files,state,service,make,logs,input:{vaultId:'one',path:'Areas/Example.md',destination:'Reference/New example.md',expectedHash:source.hash!}};
}
test('whole-read move repairs links and metadata-only ledger survives restart',async()=>{
 const f=await fixture();try{
  const result=await f.service.move(f.input,undefined,'reader');assert.equal(result.outcome,'moved_supported_links_updated');
  assert.equal(f.files.notes.get('one/Index.md'),'[[Reference/New example#Heading|alias]]\n');
  assert.equal(JSON.stringify(f.state.value).includes('body'),false);
  await f.service.stop();const next=f.make();await next.start();
  assert.ok(result.operationId);
  const status=await next.moveStatus({vaultId:'one',operationId:result.operationId});assert.equal(status.outcome,'moved_supported_links_updated');assert.equal(f.files.moves,1);await next.stop();
 }finally{await f.service.stop();}
});
test('stale repair is partial and preserves concurrent bytes',async()=>{
 const f=await fixture();const move=f.files.move.bind(f.files);f.files.move=async i=>{const r=await move(i);f.files.notes.set('one/Index.md','concurrent');return r;};
 try{const r=await f.service.move(f.input,undefined,'reader');assert.equal(r.outcome,'moved_links_partial');assert.equal(f.files.notes.get('one/Index.md'),'concurrent');}finally{await f.service.stop();}
});
test('lost repair reply is inspected without replay or leaking raw errors',async()=>{
 const f=await fixture();let calls=0;const commit=f.files.commit.bind(f.files);f.files.commit=async i=>{calls++;await commit(i);throw new Error('PRIVATE_SENTINEL');};
 try{const r=await f.service.move(f.input,undefined,'reader');assert.equal(r.outcome,'moved_supported_links_updated');assert.equal(calls,1);assert.equal(f.logs.join().includes('PRIVATE_SENTINEL'),false);}finally{await f.service.stop();}
});
test('cancellation after physical move leaves repair unstarted and is not replayed',async()=>{
 const f=await fixture();const c=new AbortController(), move=f.files.move.bind(f.files);f.files.move=async i=>{const r=await move(i);c.abort();return r;};
 try{const r=await f.service.move(f.input,c.signal,'reader');assert.equal(r.outcome,'moved_links_partial');assert.equal(f.files.notes.get('one/Index.md'),'[[Example#Heading|alias]]\n');assert.equal(f.state.value.moves?.[0].repairs[0].outcome,'unstarted');}finally{await f.service.stop();}
});
test('a different reader and stale source are refused before physical writes',async()=>{
 const f=await fixture();try{await assert.rejects(f.service.move(f.input,undefined,'other'),/complete_read_required/);f.files.notes.set('one/Areas/Example.md','changed');await assert.rejects(f.service.move(f.input,undefined,'reader'),/conflict/);assert.equal(f.files.moves,0);}finally{await f.service.stop();}
});

test('an incomplete listing or exhausted link discovery budget stops before a move is recorded', async () => {
  const f = await fixture();
  const list = f.files.list.bind(f.files);
  const assertRefused = async (category: string, message: RegExp) => {
    await assert.rejects(f.service.move(f.input, undefined, 'reader'),
      error => error instanceof VaultError && error.category === category && message.test(error.nextAction)
        && !error.nextAction.includes('PRIVATE_SENTINEL'));
    assert.equal(f.files.moves, 0);
    assert.equal(f.state.value.moves, undefined);
    assert.equal(f.logs.at(-1), 'move_preflight:' + category);
  };
  try {
    f.files.list = async (id, revision) => ({ ...await list(id, revision), incomplete: true, paths: ['PRIVATE_SENTINEL.md'] });
    await assertRefused('unavailable', /vault listing was incomplete/);
    f.files.list = async (id, revision) => ({
      ...await list(id, revision),
      paths: Array.from({ length: 10001 }, (_, i) => `Note ${i}.md`),
    });
    await assertRefused('capacity', /10000 notes/);

    f.files.list = list;
    const text = 'a'.repeat(1024 * 1024);
    for (let i = 0; i < 129; i++) f.files.notes.set(`one/Long note ${i}.md`, text);
    await assertRefused('capacity', /128 MiB total text/);
    assert.equal(f.files.notes.get('one/Areas/Example.md'), 'body\n');
  } finally {
    await f.service.stop();
  }
});

test('paths added during discovery stop the move before any record or write', async () => {
  const f = await fixture();
  const list = f.files.list.bind(f.files);
  try {
    let calls = 0;
    f.files.list = async (id, revision) => {
      if (++calls === 2) f.files.notes.set('one/Concurrent.md', '[[Example]]');
      return list(id, revision);
    };
    await assert.rejects(f.service.move(f.input, undefined, 'reader'),
      error => error instanceof VaultError && error.category === 'conflict' && /paths changed/.test(error.nextAction));
    assert.equal(f.files.moves, 0);
    assert.equal(f.state.value.moves, undefined);
  } finally {
    await f.service.stop();
  }
});

test('the move stops before writing if preflight runs out of time', async () => {
  let now = Date.now();
  const f = await fixture(() => now);
  const read = f.files.read.bind(f.files);
  try {
    f.files.read = async (...args) => {
      now += 20000;
      return read(...args);
    };
    await assert.rejects(f.service.move(f.input, undefined, 'reader'),
      error => error instanceof VaultError && error.category === 'capacity' && /20-second time limit/.test(error.nextAction));
    assert.equal(f.files.moves, 0);
    assert.equal(f.state.value.moves, undefined);
  } finally {
    await f.service.stop();
  }
});

test('a repair that would grow a note past the store write limit stops before the physical move', async () => {
  const f = await fixture();
  try {
    const backlink = '[[Example]]\n';
    f.files.notes.set('one/Index.md', 'a'.repeat(1024 * 1024 - backlink.length - 2) + '\n\n' + backlink);
    await assert.rejects(f.service.move(f.input, undefined, 'reader'),
      error => error instanceof VaultError && error.category === 'capacity' && /1 MiB write limit/.test(error.nextAction));
    assert.equal(f.files.moves, 0);
    assert.equal(f.state.value.moves, undefined);
  } finally {
    await f.service.stop();
  }
});


test('read-only planning scans past repeated blockers and samples later reasons', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 14; i++) f.files.notes.set(`one/Blocker ${i}.md`, '<img src="PRIVATE_TARGET.png">');
    f.files.notes.set('one/Z.md', '[[Reference/New example]]');
    await assert.rejects(f.service.move({ ...f.input, dryRun: true }, undefined, 'reader'), error => {
      assert.ok(error instanceof MoveLinkError);
      assert.equal(error.location.reason, 'html_link_attribute');
      assert.equal(error.additionalLocations?.length, 11);
      assert.ok(error.additionalLocations?.some(location => location.path === 'Z.md' && location.reason === 'ambiguous_target'));
      assert.deepEqual(error.previewBlockers?.counts, { html_link_attribute: 14, ambiguous_target: 1 });
      assert.equal(error.previewBlockers?.notesChecked, 17);
      assert.equal(error.previewBlockers?.locationsTruncated, true);
      assert.doesNotMatch(JSON.stringify(error.previewBlockers), /PRIVATE_TARGET/);
      return true;
    });
    assert.equal(f.files.moves, 0);
    assert.equal(f.state.value.moves, undefined);
    await assert.rejects(f.service.move(f.input, undefined, 'reader'), error => error instanceof MoveLinkError
      && error.location.reason === 'html_link_attribute' && error.previewBlockers === undefined);
  } finally {
    await f.service.stop();
  }
});
