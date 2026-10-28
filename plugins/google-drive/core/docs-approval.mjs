// Preserve the host's lifecycle evidence without accepting arbitrary reasons or
// submitted content as diagnostics. None of these states proves UI visibility.
const reasons = new Set(['user', 'request-aborted', 'thread-stopped', 'thread-deleted', 'plugin-disposed', 'server-restarted', 'timeout']);
export function docsApprovalDecision(response) {
  if (response?.outcome === 'cancelled' && reasons.has(response.reason)) {
    return { outcome: 'cancelled', reason: response.reason };
  }
  if (response?.outcome === 'submitted' && response.value && typeof response.value === 'object') {
    if (response.value.approved === true) return { outcome: 'approved' };
    if (response.value.approved === false) return { outcome: 'declined', reason: 'owner_declined' };
  }
  return { outcome: 'approval_unavailable', reason: 'invalid_response' };
}
const guidance = Object.freeze({
  user: 'The owner cancelled the review. No write was attempted.',
  owner_declined: 'The owner declined the replacement. No write was attempted.',
  timeout: 'The review expired without a submitted choice. This is not an owner rejection and does not prove the card was visible. Check the originating thread in BB before requesting a fresh review.',
  'request-aborted': 'The review request was aborted; no owner choice was received.',
  'thread-stopped': 'The thread stopped before approval completed.',
  'thread-deleted': 'The thread was deleted before approval completed.',
  'plugin-disposed': 'The plugin stopped or reloaded before approval completed.',
  'server-restarted': 'The server restarted before approval completed.',
  caller_aborted: 'The caller stopped before the replacement could be submitted.',
  request_failed: 'BB could not complete the approval request. Card delivery is unconfirmed. Check the originating thread; no write was attempted.',
  invalid_response: 'No valid owner approval was received. No write was attempted.',
});
export function docsApprovalReceipt(decision) {
  return { ...decision, writeAttempted: false, guidance: guidance[decision.reason] || guidance.invalid_response };
}
export function diagnoseDocsApproval(diagnose, decision) {
  // A declined/user-cancelled review is an ordinary owner choice, not a failure.
  if (!['approved', 'owner_declined', 'user'].includes(decision.reason || decision.outcome)) {
    diagnose(`docs_approval_${Object.hasOwn(guidance, decision.reason) ? decision.reason : 'invalid_response'}`, undefined);
  }
}
