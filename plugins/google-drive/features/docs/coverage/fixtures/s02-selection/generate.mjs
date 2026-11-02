// Scaffolding only: original inert source/oracles, never production output.
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expand } from '../../expand.mjs';
import { selectionFixture } from '../../selection-fixtures.mjs';
const manifest=JSON.parse(readFileSync(new URL('../../obligations.json',import.meta.url))),records=expand(manifest).filter(r=>r.earliestSlice==='S02'&&['C004','C016','C017','C020'].includes(r.ledgerId));
for(const r of records)writeFileSync(new URL(r.caseId+'.json',import.meta.url),JSON.stringify(selectionFixture(r),null,2)+'\n');
const groups=Object.groupBy(records,r=>r.ledgerId),feature='@docs @bridgeExecution\nFeature: Original inspection outline and exact read-side selection\n\n'+Object.values(groups).map(rs=>`@${rs[0].ledgerId} @${rs[0].featureId} @${rs[0].scenarioId}\n  Scenario Outline: Exact S02 selection [<caseId>]\n    When the offline production bridge executes "<caseId>"\n    Examples:\n      | caseId |\n${rs.map(r=>`      | ${r.caseId} |`).join('\n')}`).join('\n\n')+'\n';
writeFileSync(new URL('../../../semantic-s02-selection.feature',import.meta.url),feature);
console.log('Authored',records.length,'independent original selection fixtures');
