import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { When, Then } from '@cucumber/cucumber';
import { assetBoundary } from '../../support/assets.mjs';
import { formatArgs, key } from '../../support/world.mjs';
Then('matching applied state remains an observation and the key cannot replay', async function () {
  assert.equal(this.status.outcome, 'observed_matching'); assert.equal(this.status.providerAcknowledged, false);
  assert.equal(await this.store.activeFormatting('doc-a'), key);
  const repeated = await this.format.format(formatArgs); assert.equal(repeated.writeAttempted, false);
  assert.equal(this.mutations.length, 1); assert.equal(await this.store.activeFormatting('doc-a'), key);
});
Then('the complete independent {string} after-document matches', function (kind) {
  const vector = JSON.parse(readFileSync(new URL('../../coverage/fixtures/legacy-vectors.json', import.meta.url)));
  assert.equal(this.result.outcome, 'verified'); assert.deepEqual(this.doc, vector[kind].after);
  assert.deepEqual(this.mutations[0].body, vector[kind].request);
});
When('the real asset validator inspects the {string} boundary', async function (fault) {
  this.asset = assetBoundary(fault);
  try { this.assetResult = await this.asset.assets.inspect('https://art.example.test/red.png'); }
  catch (e) { this.assetError = e; }
});
Then('the asset outcome is {string} with {int} DNS and {int} HTTPS calls', function (outcome, dns, https) {
  if (outcome === 'valid') assert.deepEqual(this.assetResult, this.asset.expected);
  else { assert.ok(this.assetError); assert.equal(this.assetResult, undefined); assert.doesNotMatch(this.assetError.message, /PRIVATE_/); }
  assert.equal(this.asset.calls.filter(x => x === 'dns').length, dns);
  assert.equal(this.asset.calls.filter(x => x === 'https').length, https); this.asset.check();
});
When('an unexpected {string} route reaches the fixture', async function (port) {
  if (port === 'HTTP') {
    await this.init(); await assert.rejects(() => this.fetch('https://unexpected.example.test'));
    this.closedCheck = () => assert.deepEqual(this.unexpected, []);
    this.acknowledgeFault = () => this.acknowledgeHttpFault({url:'https://unexpected.example.test',method:'GET'});
  } else {
    this.asset = assetBoundary();
    await assert.rejects(() => this.asset.assets.inspect(port === 'DNS' ? 'https://unexpected.example.test/red.png' : 'https://art.example.test/other.png'));
    this.closedCheck = this.asset.check;
    this.acknowledgeFault = () => this.asset.acknowledge(`unexpected ${port}`);
  }
});
When('a {string} fixture failure is swallowed before teardown', async function (fault) {
  await this.init(); this.teardownDb = this.host.bb.storage.database();
  if (fault === 'HTTP contract') {
    await assert.rejects(() => this.fetch('https://docs.googleapis.com/v1/documents/doc-a:batchUpdate', {method:'POST',body:'invalid-json'}));
    this.consumeTeardownFault = () => this.acknowledgeHttpFault({wire:'invalid batch'});
  } else {
    this.asset = assetBoundary(fault === 'DNS contract' ? 'dnsContract' : fault === 'HTTPS contract' ? 'httpsContract' : 'none');
    const uri = fault === 'DNS' ? 'https://unexpected.example.test/red.png' : fault === 'HTTPS' ? 'https://art.example.test/other.png' : 'https://art.example.test/red.png';
    await assert.rejects(() => this.asset.assets.inspect(uri));
    this.consumeTeardownFault = () => this.asset.acknowledge(fault.includes('contract') ? fault : `unexpected ${fault}`);
  }
  try { await this.close(); } catch (error) { this.teardownError = error; }
});
When('malformed batch {string} is swallowed before teardown', async function (shape) {
  const vectors = JSON.parse(readFileSync(new URL('../../coverage/fixtures/residual-vectors.json', import.meta.url)));
  assert.ok(Object.hasOwn(vectors.batches, shape), 'known malformed batch fixture');
  await this.init(); this.teardownDb = this.host.bb.storage.database();
  await assert.rejects(() => this.fetch('https://docs.googleapis.com/v1/documents/doc-a:batchUpdate', {method:'POST',body:JSON.stringify(vectors.batches[shape])}));
  assert.deepEqual(this.unexpected, [{wire:'invalid batch'}], 'exactly one contract fault');
  this.consumeTeardownFault = () => this.acknowledgeHttpFault({wire:'invalid batch'});
  try { await this.close(); } catch (error) { this.teardownError = error; }
});
Then('teardown rejects the recorded fault and still closes SQLite', function () {
  assert.equal(this.teardownError?.message, 'closed-network teardown failed');
  assert.equal(this.teardownDb.open, false, 'cleanup must run despite fixture assertions');
  this.consumeTeardownFault();
});
Then('its closed-network check fails', function () {
  assert.throws(this.closedCheck);
  this.acknowledgeFault(); // exact, one-fault acknowledgement only; later faults still fail teardown
});
