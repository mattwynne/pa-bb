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
      assert.deepEqual(JSON.parse(result.stdout), { exampleOnly: true, outcome, writeAttempted: false });
    }
    assert.equal(calls, 0);
  } finally { await harness.lifecycle.dispose(); globalThis.fetch = original; }
});
