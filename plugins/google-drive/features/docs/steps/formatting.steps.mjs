import assert from 'node:assert/strict';
import { Given, When, Then, After, setWorldConstructor } from '@cucumber/cucumber';
import { DocsWorld, key, barrier } from '../support/world.mjs';
import { createDocsFormatService } from '../../../core/docs-format.mjs';
import { createDocsEditService } from '../../../core/docs-edit.mjs';
setWorldConstructor(DocsWorld);
After(async function () { await this.close(); });
Given('the Docs boundary will fail at {string}', async function (fault) { await this.init(fault); });
When('formatting is applied once', async function () { await this.apply(); });
Then('the formatting outcome is {string} with {int} mutation', function (outcome, count) {
  assert.equal(this.result.outcome, outcome); assert.equal(this.mutations.length, count);
});
Then('the acknowledgement and unresolved claim are retained', async function () {
  assert.equal(this.result.writeAttempted, true); assert.equal(this.result.providerAcknowledged, true);
  assert.equal(this.result.appliedRevisionId, 'rev-b');
  assert.equal((await this.store.getFormatting(key)).appliedRevision, 'rev-b');
  assert.equal(await this.store.activeFormatting('doc-a'), key);
});
When('SQLite is closed and reopened and the same key is inspected', async function () {
  const path = this.databasePath; await this.reopen(); assert.equal(this.databasePath, path); await this.recover();
});
Then('recovery is unavailable without forgetting the acknowledgement or releasing the claim', async function () {
  assert.equal(this.status.outcome, 'verification_unavailable'); assert.equal(this.status.providerAcknowledged, true);
  assert.equal(this.status.writeAttempted, false); assert.equal(this.status.historicalWriteAttempted, true); assert.equal(this.mutations.length, 1);
  assert.equal(await this.store.activeFormatting('doc-a'), key);
});
Then('diagnostics contain only the safe verification boundary', function () {
  assert.deepEqual(this.logs, ['Google Drive docs_format_verify http_status=403', 'Google Drive docs_format_recovery http_status=403']);
  assert.doesNotMatch(JSON.stringify([this.logs, this.result, this.status]), /PRIVATE_|writer@example/);
});
Then('the saved lifecycle is {string} with acknowledgement {string} and claim {string}', async function (state, ack, claim) {
  const saved = await this.store.getFormatting(key);
  assert.equal(saved.state, state); assert.equal(!!saved.appliedRevision, ack === 'true');
  assert.equal(await this.store.activeFormatting('doc-a'), claim === 'held' ? key : null);
  // The legacy rejected output means not accepted, not absence of a dispatched POST.
  assert.equal(this.result.writeAttempted, !['rejected', 'not_submitted'].includes(this.result.outcome));
  if (this.fault === 'storage') assert.equal(this.result.providerAcknowledged, true);
});
Then('the historical attempt is {string} and this status call attempted no mutation', function (history) {
  assert.equal(this.status.historicalWriteAttempted, history === 'unknown' ? null : history === 'true');
  assert.equal(this.status.writeAttempted, false);
});
Then('no private fault detail escaped', function () {
  assert.doesNotMatch(JSON.stringify([this.logs, this.result, this.status]), /PRIVATE_|writer@example/);
  if (this.result.outcome === 'uncertain') assert.doesNotMatch(this.result.error || '', /No write was attempted|nothing was written/i);
});
When('{string} pauses in final authorization and {string} changes', async function (kind, change) {
  const gate = barrier(); this.finalAuth = gate.wait;
  const pending = this.apply(kind).catch(error => { this.failure = error; });
  await gate.reached; await this.change(change); gate.release(); await pending;
});
When('{string} pauses at {string} and {string} changes', async function (kind, boundary, change) {
  const gate = barrier();
  if (boundary === 'policy') {
    const ports = { ...this.ports, approvalRequired: async () => { if (this.authCount === 2) await gate.wait(); return this.policy; } };
    if (kind === 'format') this.format = createDocsFormatService(ports);
    else this.edit = createDocsEditService(ports);
  } else {
    const target = kind === 'format' ? this.store : this.store.images;
    const name = boundary === 'intent' ? 'startFormattingWrite' : kind === 'format' ? 'getFormatting' : 'active';
    const original = target[name].bind(target);
    target[name] = async (...args) => {
      const result = await original(...args);
      if (boundary === 'intent' || this.authCount === 2) await gate.wait();
      return result;
    };
  }
  const pending = this.apply(kind).catch(error => { this.failure = error; });
  await gate.reached; await this.change(change); gate.release(); await pending;
});
Then('the final gate submits no mutation', async function () {
  assert.equal(this.authCount, 2); assert.equal(this.mutations.length, 0);
  if (this.result) { assert.equal(this.result.outcome, 'not_submitted'); assert.equal(this.result.writeAttempted, false); }
  else assert.equal(this.failure?.docsWriteAttempted, false);
  assert.equal(await this.store.activeFormatting('doc-a'), null);
});
Given('the approval setting is {string}', function (policy) { this.policy = policy === 'on'; });
When('the requested {string} is applied', async function (kind) { await this.apply(kind); });
Then('the write verifies with {int} owner reviews', function (cards) {
  assert.equal(this.result.outcome, 'verified'); assert.equal(this.approvals, cards); assert.equal(this.mutations.length, 1);
  assert.equal(this.result.approval, cards ? 'owner_approved' : 'disabled_in_settings');
});
