import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schemaShape } from '../support/production-host.mjs';
const contract=JSON.parse(readFileSync(new URL('./fixtures/bridge-schema-contract.json',import.meta.url)));
// Expand only this inert contract's local, acyclic references. Never derive an
// expectation from the current registrar, Zod schema, or captured inventory.
function expected(value,stack=[]) {
  if(Array.isArray(value))return value.map(v=>expected(v,stack));
  if(!value||typeof value!=='object')return value;
  if(value.$ref){assert.deepEqual(Object.keys(value),['$ref']);assert.ok(contract.definitions[value.$ref]&&!stack.includes(value.$ref));return expected(contract.definitions[value.$ref],[...stack,value.$ref]);}
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expected(v,stack)]));
}
function capability(value) {
  if(Array.isArray(value))return value.map(capability);
  if(!value||typeof value!=='object')return value;
  // No constraints, unknown keywords or object policies are silently dropped.
  return Object.fromEntries(Object.entries(value).filter(([k])=>!['$schema','description'].includes(k)).map(([k,v])=>[k,
    ['properties','patternProperties','$defs','definitions'].includes(k)
      ?Object.fromEntries(Object.entries(v).map(([name,schema])=>[name,capability(schema)]))
      :['const','enum','default','examples'].includes(k)?structuredClone(v):capability(v)]));
}
export function assertRecursiveContract(tools) {
  for(const [name,shapes] of Object.entries(contract.tools)){
    const schema=tools.find(t=>t.name===name)?.parameters;assert.ok(schema,'missing contract registration');
    for(const io of ['input','output'])assert.deepEqual(capability(schemaShape(schema,io)),expected(shapes[io]),`independent recursive schema contract: ${name} ${io}`);
  }
  // JSON Schema cannot express the one-heading Zod refinements. Probe the
  // original registered schema, including the nested section.before refinement.
  const scope={tabs:{ids:['tab-d']},segments:[{kind:'body'}]};
  for(const name of ['docs_read','docs_find']){
    const schema=tools.find(t=>t.name===name).parameters;
    const base={account:'reader@example.test',snapshotId:'snap-d',scope,...name==='docs_read'?{format:'text'}:{}};
    for(const heading of [{},{headingId:'h',text:'Heading'},{path:['Heading'],text:'Heading'}]){
      for(const selector of [{heading},{section:{...heading,includeHeading:true}},{section:{text:'Heading',includeHeading:true,before:heading}}])
        assert.equal(schema.safeParse({...base,selector}).success,false,'heading refinement must reject absent/ambiguous identity');
    }
    for(const heading of [{headingId:'h'},{text:'Heading'},{path:['Heading']}]){
      assert.equal(schema.safeParse({...base,selector:{heading}}).success,true,'valid heading refinement control');
      assert.equal(schema.safeParse({...base,selector:{section:{text:'Heading',includeHeading:true,before:heading}}}).success,true,'valid nested heading control');
    }
  }
  const metadata=tools.find(t=>t.name==='gdrive_get_file').parameters;
  assert.deepEqual(metadata.parse({account:'reader@example.test',fileId:'doc-d',unknownFixtureField:'strip me'}),{account:'reader@example.test',fileId:'doc-d'},'existing metadata stripping policy');
}
