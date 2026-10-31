import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { SHEETS_RACE_WARNING } from '../../core/sheets-edit.mjs';
const states = ['values','long','clear','invalid','error','busy','formulas'] as const;
export default function plugin(bb: BbPluginApi) {
  const results = new Map<string, unknown>();
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(states) }), output: z.object({ staged: z.boolean() }) },
    result: { input: z.object({ threadId: z.string() }), output: z.any() } }, {
    async stage({ threadId, state }) {
      const formulaMode = state === 'formulas' || state === 'error';
      const matrix = formulaMode ? [[{formula: '=SUM(A1:A2)'}, '=SUM(A1:A2)'], [{date: '2027-01-01'}, {cad: 125.5}]] : state === 'long' ? [['<script>synthetic & safe</script> ' + 'long value '.repeat(100)]] : state === 'clear' ? [[null]] : [['=SUM(A1:A2)', true], [{date: '2024-02-29'}, {cad: 125.5}]];
      const payload = { account: 'owner@example.test', spreadsheetId: 'synthetic-sheet', title: 'Synthetic spreadsheet approval', tabTitle: "Plan's A1", operationId: '11111111-1111-4111-8111-111111111111',
        range: { sheetId: 7, startRow: 2, startColumn: 1, rowCount: matrix.length, columnCount: matrix[0].length },
        ...(formulaMode ? {mode: 'formulas', calculation: [{row: 2, column: 1, calculation: {errorType: 'DIVIDE_BY_ZERO'}}]} : {}),
        before: matrix.map((r,y) => r.map((_v,x) => formulaMode && y === 0 && x === 0 ? {formulaValue: '=1/0'} : { stringValue: 'Before' })), values: matrix, formatTypedValues: state === 'values', beforeFormats: matrix.map(r => r.map(() => ({type: 'TEXT'}))), concurrency: SHEETS_RACE_WARNING, exampleOnly: true, reviewState: state };
      results.delete(threadId);
      void bb.ui.requestInput({ threadId, rendererId: 'sheets-edit-approval', title: 'Review spreadsheet values (synthetic)', payload: state === 'invalid' ? { reviewState: state } : payload,
        describeSubmission: () => ({ title: 'Synthetic choice — no Google access' }) }).then(r => results.set(threadId, r), () => results.set(threadId, { outcome: 'interrupted' }));
      return { staged: true };
    }, async result({ threadId }) { return results.get(threadId) ?? null; },
  });
}
