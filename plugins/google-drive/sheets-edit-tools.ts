import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createSheetsEditService, editInspectSchema, editRangeSchema, editStatusSchema, sheetsEditCategory, sheetsEditMessage } from './core/sheets-edit.mjs';
import { docsApprovalDecision } from './core/docs-approval.mjs';
import { docsFailureCategory } from './core/docs-edit.mjs';
import { failureCategory } from './diagnostic.mjs';
import { FORMULA_FUNCTIONS } from './core/sheets-formula.mjs';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createSheetsEditStore } from './adapters/sheets-edit-store.mjs';
import type { createSheetsEditAdapter } from './adapters/sheets-edit.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
const definitions: Record<string, { parameters: z.ZodType; description: string }> = {
  gsheets_inspect_for_edit: { parameters: editInspectSchema, description: 'Inspect at most 100 cells/20 columns with formatting/notes and a comparison fingerprint. Default literal mode rejects formulas. Explicit mode formulas also inspects existing entered formulas and separate calculation evidence; computed-only cells, rich text/chips/validation/protected tabs/tables remain rejected. Merges elsewhere are allowed; exact top-left merged-anchor plain-text edits in literal mode inspect the complete bounded merge. Covered/mixed targets and merged formulas/typed values are rejected. Fingerprint is never a Google revision/CAS guard.' },
  gsheets_update_range: { parameters: editRangeSchema, description: 'Preview (default), then apply a user-requested rectangle of literal string/number/boolean/null and explicit {date}/{cad} values with the SAME operationId and arguments. Mandatory owner review; no optout. Null clears a cell. Existing formatting stays unless formatTypedValues=true explicitly requests date/CAD formats on typed cells. At most 100 cells/20 columns/20000 text units. Formula authoring requires explicit mode formulas and {formula:...} values under the bounded in-workbook financial grammar; strings starting = remain literal. Default mode literal rejects formula objects. A merged target permits only one exact top-left text/clear anchor in literal mode, with unchanged merge/notes/styles and full-footprint comparison; no merged formulas or format changes. Formula readback is separate from calculation errors/delays. No arbitrary formats/requests. Google has no revision/CAS guard; concurrent edits may be overwritten. Single-use receipt; never retry uncertain writes.' },
  gsheets_edit_status: { parameters: editStatusSchema, description: 'Read-only recovery of a Sheets edit with the SAME account/operationId. Exact bounded current readback cannot attribute a lost-response write or prove it finished. Unresolved locks remain held, even when values match. Never submits, replays, rolls back or unlocks an edit.' },
};
export const SHEETS_EDIT_TOOLS = Object.keys(definitions);
// The caller appends SHEETS_EDIT_MIGRATION to the existing migration history and supplies
// the existing verifiedAccess-backed Sheets adapter, never a new auth path.
export function registerSheetsEditTools(bb: BbPluginApi, accounts: ReturnType<typeof createBbStore>, operations: ReturnType<typeof createSheetsEditStore>,
  drive: ReturnType<typeof createGoogleAdapter>['drive'], sheets: ReturnType<typeof createSheetsEditAdapter>) {
  bb.rpc.register({ sheetsFormulaCapabilities: { input: z.null(), output: z.object({ contract: z.literal('sheets-financial-formulas-v1'), mode: z.literal('formulas'), literalDefault: z.literal(true), maxCells: z.literal(100), maxFormulaUnits: z.literal(2000), functions: z.array(z.string()), approval: z.literal('mandatory') }) } }, {
    async sheetsFormulaCapabilities() { return { contract: 'sheets-financial-formulas-v1' as const, mode: 'formulas' as const, literalDefault: true as const, maxCells: 100 as const, maxFormulaUnits: 2000 as const, functions: FORMULA_FUNCTIONS, approval: 'mandatory' as const }; },
  });
  bb.rpc.register({ sheetsMergeCapabilities: { input: z.null(), output: z.object({ contract: z.literal('sheets-merged-anchor-text-v1'), anchorOnly: z.literal(true), literalTextOnly: z.literal(true), maxInspectionCells: z.literal(100), maxInspectionColumns: z.literal(20), approval: z.literal('mandatory') }) } }, {
    async sheetsMergeCapabilities() { return { contract: 'sheets-merged-anchor-text-v1' as const, anchorOnly: true as const, literalTextOnly: true as const, maxInspectionCells: 100 as const, maxInspectionColumns: 20 as const, approval: 'mandatory' as const }; },
  });
  for (const [name, definition] of Object.entries(definitions)) {
    bb.agents.registerTool({ name, ...definition,
      instructions: name === 'gsheets_update_range' ? 'Only for explicit user-requested edits. Inspect, preview, then apply with exactly the same arguments/key and preview=false. Mandatory owner approval cannot be bypassed by the Docs replacement setting. Strings are literal, including leading =. For merged text inspect exactly its top-left cell in literal mode; review the full merged extent and exact text, never unmerge/remerge or expand the write. Merged formulas/typed values/format changes and protected/table tabs are unsupported. Author formulas only when explicitly requested: inspect/update with mode formulas and {formula:...} entries. Unknown constructs, names, external imports/custom/script functions are rejected; do not bypass the grammar with text or alter scopes/settings. Exact formula readback is not calculation success; errors/delays never authorize replay/rollback. Sheets offers no revision/CAS guard; comparison cannot eliminate concurrent overwrites. Only verified confirms bounded readback after an acknowledged response. After uncertainty inspect the SAME account/key; never retry, replace the key, roll back or force-unlock. No real provider writes for testing without specific authorization.' : undefined,
      async execute(args, ctx) {
        const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${sheetsEditCategory(error)} ${docsFailureCategory(error)} ${failureCategory(error)}`);
        const approve = (proposal: Parameters<BbPluginApi['ui']['requestInput']>[0]['payload']) => bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'sheets-edit-approval', title: 'Review spreadsheet values', payload: proposal,
          describeSubmission: value => ({ title: docsApprovalDecision({ outcome: 'submitted', value }).outcome === 'approved' ? 'Spreadsheet edit approved (not yet verified)' : 'Spreadsheet edit not approved' }),
        });
        const service = createSheetsEditService({ accounts, operations, drive, sheets, approve, diagnose });
        try {
          const result = name === 'gsheets_inspect_for_edit' ? await service.inspect(args) : name === 'gsheets_update_range' ? await service.update(args, ctx.signal) : await service.status(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          diagnose(`agent_tool ${name}`, error);
          return { content: [{ type: 'text' as const, text: sheetsEditMessage(error) }], isError: true };
        }
      },
    });
  }
}
