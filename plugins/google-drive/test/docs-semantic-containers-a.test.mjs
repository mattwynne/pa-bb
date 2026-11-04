import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerCases,checkContainerPure,checkContainerApplication } from '../features/docs/support/a-container-checks.mjs';
const {schemas}=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/docs-discovery.json',import.meta.url)));
test('A4 container expectations match pinned property types',()=>{
  assert.equal(schemas.ParagraphStyle.properties.tabStops.type,'array');
  assert.equal(schemas.SectionStyle.properties.columnProperties.type,'array');
  assert.equal(schemas.Dimension.type,'object');
  assert.equal(schemas.WeightedFontFamily.type,'object');
  assert.equal(schemas.TextStyle.properties.bold.type,'boolean');
  assert.equal(schemas.Dimension.properties.magnitude.type,'number');
  assert.equal(schemas.WeightedFontFamily.properties.fontFamily.type,'string');
  assert.equal(schemas.Dimension.properties.unit.type,'string');
});
for(const c of containerCases){
  test(`A4 typed container pure ${c.id}`,()=>checkContainerPure(c));
  test(`A4 typed container application memory ${c.id}`,()=>checkContainerApplication(c));
}
