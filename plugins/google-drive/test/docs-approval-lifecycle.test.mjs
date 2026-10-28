import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { docsApprovalDecision, docsApprovalReceipt, diagnoseDocsApproval } from '../core/docs-approval.mjs';

const reasons = ['user', 'timeout', 'request-aborted', 'thread-stopped', 'thread-deleted', 'plugin-disposed', 'server-restarted'];
test('every host cancellation reason survives; unknown content and malformed choices fail closed', () => {
  const logs = [];
  for (const reason of reasons) {
    const decision = docsApprovalDecision({ outcome: 'cancelled', reason });
    assert.equal(docsApprovalReceipt(decision).reason, reason);
    assert.equal(docsApprovalReceipt(decision).writeAttempted, false);
    diagnoseDocsApproval(stage => logs.push(stage), decision);
  }
  assert.equal(logs.length, reasons.length - 1); // ordinary owner cancellation is not a failure
  assert.match(logs.join(' '), /docs_approval_timeout/);
  for (const response of [null, true, { outcome: 'cancelled', reason: 'private-token-content' }, { outcome: 'submitted', value: { approved: 'true', secret: 'private-token-content' } }]) {
    const decision = docsApprovalDecision(response);
    diagnoseDocsApproval(stage => logs.push(stage), decision);
    assert.equal(decision.outcome, 'approval_unavailable');
    assert.doesNotMatch(JSON.stringify([docsApprovalReceipt(decision), logs]), /private-/);
  }
  assert.equal(docsApprovalDecision({ outcome: 'submitted', value: { approved: true } }).outcome, 'approved');
  assert.equal(docsApprovalDecision({ outcome: 'submitted', value: { approved: false } }).outcome, 'declined');
});

test('native no-op review routes to the invoking thread and completes after idle without any Google access', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('private-network-sentinel'); };
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-drive' });
  try {
    await plugin(bb);
    const done = harness.behavior.callAgentTool('gdocs_review_edit_example', {}, { threadId: 'synthetic-origin' });
    await new Promise(resolve => setImmediate(resolve));
    const request = harness.inspection.pendingInteractions[0];
    assert.equal(request.threadId, 'synthetic-origin');
    assert.equal(request.payload.exampleOnly, true);
    assert.equal(request.payload.documentId, 'example-no-document');
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'synthetic-origin', status: 'idle' }), lastAssistantText: 'Waiting for the example.' });
    assert.equal(harness.inspection.pendingInteractions.length, 1);
    harness.behavior.submitInteraction(request.id, { approved: true });
    const result = await done;
    assert.deepEqual(JSON.parse(result.content[0].text), { exampleOnly: true, outcome: 'approved_example', writeAttempted: false });
    assert.equal(calls, 0);
  } finally { await harness.lifecycle.dispose(); globalThis.fetch = original; }
});
// The fake SDK does not emulate provider round-trip detachment or mobile UI.
// Exercise those boundaries in live BB with gdocs_review_edit_example; do not
// substitute the CLI or this test for that acceptance gate.
