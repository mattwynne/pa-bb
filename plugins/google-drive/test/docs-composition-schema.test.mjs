import test from 'node:test';
import assert from 'node:assert/strict';
import {draftOwner as owner} from './docs-semantic-draft-fixtures.mjs';
import {compositionStyleSchema,compositionContentSchema,compositionCombineSchema} from '../docs-composition-tools.mjs';
test('actual family/extend/combine schemas refuse private conveniences, raw requests, refs, mode switches and unknown operations',()=>{
 const base={account:owner.account,draft:{kind:'new',requestId:'strict',destination:{snapshotId:'snapshot'},mode:'direct'},commands:[{op:'text',target:{node:'node'},set:{bold:true}}]};assert.equal(compositionStyleSchema.safeParse(base).success,true);
 for(const x of [{...base,snapshotId:'private-convenience'},{...base,draft:{...base.draft,mode:'suggest'}},{...base,draft:{...base.draft,sources:[]}},{...base,commands:[{op:'text',target:{ref:'generated'},set:{bold:true}}]},{...base,commands:[{op:'text',target:{node:'node'},set:{bold:true,italic:true}}]},{...base,commands:[{op:'raw',requests:[]}]}])assert.equal(compositionStyleSchema.safeParse(x).success,false);
 assert.equal(compositionContentSchema.safeParse({...base,commands:[{op:'replace',target:{node:'node'},oldText:'one',newText:'two'}]}).success,true);assert.equal(compositionContentSchema.safeParse({...base,commands:[{op:'paragraphReplace',node:'private',oldText:'one',newText:'two'}]}).success,false);assert.equal(compositionCombineSchema.safeParse({account:owner.account,requestId:'one',inputs:[{draftId:'a0000000-0000-4000-8000-000000000001',expectedDraftHash:'a'.repeat(64)},{draftId:'a0000000-0000-4000-8000-000000000001',expectedDraftHash:'a'.repeat(64)}]}).success,false);
});
