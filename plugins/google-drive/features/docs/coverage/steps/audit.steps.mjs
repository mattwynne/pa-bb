import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';
import { readFileSync } from 'node:fs';
import { expand, allClosures } from '../expand.mjs';
import { auditEvidence } from '../audit.mjs';
import { auditControl, corruptControl, readManifest } from '../control.mjs';
import { validateRequest, validatePlannedMappings } from '../wire.mjs';
import { wireProbe, weightedFontProbe } from '../wire-probes.mjs';
import { breakStructure } from '../structure-probes.mjs';
When('the manifest structure is damaged with {string}', function (probe) {
  const manifest = readManifest(); breakStructure(manifest, probe);
  try { expand(manifest); } catch (error) { this.structureError = error; }
});
Then('inventory validation rejects it for {string}', function (reason) {
  assert.ok(this.structureError?.message.includes(reason), `expected ${reason}; got ${this.structureError?.message}`);
});
When('the approved semantic manifest is expanded', function () {
  this.manifest = readManifest(); this.expanded = expand(this.manifest); this.mapping = validatePlannedMappings(this.manifest);
});
Then('there are {int} planned keys and no enabled semantic products', function (count) {
  assert.equal(this.expanded.length,count); assert.ok(this.expanded.every(r => r.status === 'planned'));
  assert.equal(allClosures(this.manifest,this.expanded).size,1036);
  assert.deepEqual(this.manifest.expansion.variantExposure,{});
  assert.deepEqual(JSON.parse(readFileSync(new URL('../registry.json',import.meta.url))).exposed,[]);
});
When('the audit control is corrupted with {string}', function (probe) {
  const c = auditControl(['uniqueName','duplicateNameRefusal'].includes(probe) ? 'docs_plan_anchor.lifecycle/createDuplicateName__direct' : undefined);
  try { corruptControl(c,probe); try { auditEvidence(c); } catch(e) { this.auditError = e; } }
  finally { c.dispose(); }
});
Then('the coverage auditor rejects it for {string}', function (reason) {
  assert.ok(this.auditError, `auditor unexpectedly accepted ${reason}`);
  assert.ok(this.auditError.message.includes(reason), `expected ${reason}; got ${this.auditError.message}`);
});
When('the independent audit control is checked', function () {
  const c = auditControl(); try { this.auditResult = auditEvidence(c); } finally { c.dispose(); }
});
Then('its evidence join succeeds without changing the product registry', function () {
  assert.equal(this.auditResult.enabledVariants,1); // synthetic auditor input only
  assert.deepEqual(JSON.parse(readFileSync(new URL('../registry.json',import.meta.url))).exposed,[]);
});
When('the wire fixture {string} is validated', function (name) {
  const v = wireProbe(name); try { validateRequest(v.request,v.effects); } catch(e) { this.wireError = e; }
});
When('the {string} font fixture uses weight {string}', function (context, weight) {
  const v = weightedFontProbe(context, weight); try { validateRequest(v.request,v.effects); } catch(e) { this.wireError = e; }
});
Then('the wire validation is {string}', function (result) {
  if (result === 'valid') assert.equal(this.wireError,undefined); else assert.ok(this.wireError, 'invalid wire accepted');
});
