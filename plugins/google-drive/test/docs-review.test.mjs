import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

test('synthetic review CLI exercises approval, rejection, cancellation and incomplete previews without any Google request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('No network is permitted in the review example'); };
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-drive' });
  try {
    await plugin(bb);
    const help = await harness.behavior.runCli(['review-edit-example', '--help']);
    assert.equal(help.exitCode, 0); assert.match(help.stdout, /no Google API/);
    for (const [state, decision, outcome] of [['replacement', true, 'approved_example'], ['deletion', false, 'declined_example'], ['incomplete', 'cancel', 'cancelled']]) {
      const done = harness.behavior.runCli(['review-edit-example', '--thread', 'thread-example', '--state', state]);
      await new Promise(resolve => setImmediate(resolve));
      const request = harness.inspection.pendingInteractions[0];
      assert.equal(request.rendererId, 'docs-edit-approval'); assert.equal(request.payload.exampleOnly, true);
      assert.equal(request.payload.documentId, 'example-no-document');
      if (decision === 'cancel') harness.behavior.cancelInteraction(request.id);
      else harness.behavior.submitInteraction(request.id, { approved: decision });
      const result = await done;
      assert.equal(result.exitCode, 0);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.exampleOnly, true); assert.equal(receipt.outcome, outcome); assert.equal(receipt.writeAttempted, false);
      if (decision === false) assert.equal(receipt.reason, 'owner_declined');
      if (decision === 'cancel') assert.equal(receipt.reason, 'user');
    }
    for (const [state, choice] of [['formatting', true], ['formatting', false], ['formatting', 'cancel'], ['background', true], ['background', false], ['background', 'cancel']]) {
      const done = harness.behavior.runCli(['review-format-example', '--thread', 'thread-example', '--state', state]);
      await new Promise(resolve => setImmediate(resolve));
      const form = harness.inspection.pendingInteractions[0];
      assert.equal(form.rendererId, 'docs-format-approval'); assert.equal(form.payload.exampleOnly, true);
      if (state === 'background') assert.deepEqual(form.payload.page.after, { tabId: 'main', backgroundColor: '#F4F1E8' });
      if (choice === 'cancel') harness.behavior.cancelInteraction(form.id);
      else harness.behavior.submitInteraction(form.id, { approved: choice });
      const receipt = JSON.parse((await done).stdout);
      assert.equal(receipt.exampleOnly, true); assert.equal(receipt.writeAttempted, false);
      assert.equal(receipt.outcome, choice === true ? 'approved' : choice === false ? 'declined' : 'cancelled');
    }
    assert.equal(calls, 0);
  } finally { await harness.lifecycle.dispose(); globalThis.fetch = original; }
});
