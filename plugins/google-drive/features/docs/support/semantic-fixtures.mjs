// Inert examples: importing fixtures never imports/constructs SDK or SQLite.
import { readFileSync } from 'node:fs';
export const semanticVector=JSON.parse(readFileSync(new URL('../coverage/fixtures/snapshot-vector.json',import.meta.url)));
export const semanticAccount='writer@example.test';
export const semanticScope={tabs:{ids:['tab-a']},segments:[{kind:'body'}]};
