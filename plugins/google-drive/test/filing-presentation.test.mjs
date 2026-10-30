import test from 'node:test';
import assert from 'node:assert/strict';
import { filingTypeLabel, filingRoleLabel, filingAudienceLabel, filingAccessLabel } from '../core/filing-presentation.mjs';
test('friendly labels do not turn the supported MIME set into an eligibility allowlist', () => {
  assert.equal(filingTypeLabel('application/vnd.google-apps.spreadsheet'), 'Google Sheet');
  assert.equal(filingTypeLabel('application/vnd.google-apps.document'), 'Google Doc');
  assert.equal(filingTypeLabel('application/pdf'), 'PDF');
  assert.equal(filingTypeLabel('image/png'), 'Image');
  for (const value of ['', undefined, '__proto__', 'constructor', 'toString', 'application/x-future-type', '<script>private</script>']) assert.equal(filingTypeLabel(value), 'File');
  assert.deepEqual(['reader', 'commenter', 'writer', 'owner'].map(filingRoleLabel), ['Can view', 'Can comment', 'Can edit', 'Owner']);
  assert.deepEqual(['reader', 'commenter', 'writer'].map(filingAccessLabel), ['viewing', 'commenting', 'editing']);
});
test('audience labels retain identity and public discovery without protocol prefixes', () => {
  assert.equal(filingAudienceLabel({ type: 'user', emailAddress: 'person@example.invalid' }), 'person@example.invalid');
  assert.equal(filingAudienceLabel({ type: 'group', emailAddress: 'team@example.invalid' }), 'Group team@example.invalid');
  assert.equal(filingAudienceLabel({ type: 'domain', domain: 'example.invalid' }), 'Everyone at example.invalid');
  assert.equal(filingAudienceLabel({ type: 'anyone', allowFileDiscovery: false }), 'Anyone with the link');
  assert.equal(filingAudienceLabel({ type: 'anyone', allowFileDiscovery: true }), 'Anyone (publicly searchable)');
});
