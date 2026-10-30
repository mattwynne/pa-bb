import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createSheetsEditService, editInspectSchema, editRangeSchema, editStatusSchema, sheetsEditCategory, sheetsEditMessage } from './core/sheets-edit.mjs';
import { docsApprovalDecision } from './core/docs-approval.mjs';
import { docsFailureCategory } from './core/docs-edit.mjs';
import { failureCategory } from './diagnostic.mjs';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createSheetsEditStore } from './adapters/sheets-edit-store.mjs';
import type { createSheetsEditAdapter } from './adapters/sheets-edit.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
const definitions: Record<string, { parameters: z.ZodType; description: string }> = {
  gsheets_inspect_for_edit: { parameters: editInspectSchema, description: 'Inspect at most 100 ordinary literal cells in one tab, with typed values, formatting and a fingerprint. Rejects formulas, computed output, rich text, chips, validation, merged/protected tabs and tables. Fingerprint is comparison evidence, never a Google revision/CAS guard.' },
  gsheets_update_range: { parameters: editRangeSchema, description: 'Preview (default), then apply a user-requested rectangle of literal string/number/boolean/null and explicit {date}/{cad} values with the SAME operationId and arguments. Mandatory owner review; no optout. Null clears a cell. Existing formatting stays unless formatTypedValues=true explicitly requests date/CAD formats on typed cells. At most 100 cells/20 columns/20000 text units; no formulas or arbitrary formats. Google has no revision/CAS guard; concurrent edits may be overwritten. Single-use receipt; never retry uncertain writes.' },
  gsheets_edit_status: { parameters: editStatusSchema, description: 'Read-only recovery of a Sheets edit with the SAME account/operationId. Exact bounded current readback cannot attribute a lost-response write or prove it finished. Unresolved locks remain held, even when values match. Never submits, replays, rolls back or unlocks an edit.' },
};
export const SHEETS_EDIT_TOOLS = Object.keys(definitions);
// The caller appends SHEETS_EDIT_MIGRATION to the existing migration history and supplies
// the existing verifiedAccess-backed Sheets adapter, never a new auth path.
export function registerSheetsEditTools(bb: BbPluginApi, accounts: ReturnType<typeof createBbStore>, operations: ReturnType<typeof createSheetsEditStore>,
  drive: ReturnType<typeof createGoogleAdapter>['drive'], sheets: ReturnType<typeof createSheetsEditAdapter>) {
  for (const [name, definition] of Object.entries(definitions)) {
    bb.agents.registerTool({ name, ...definition,
      instructions: name === 'gsheets_update_range' ? 'Only for explicit user-requested edits. Inspect, preview, then apply with exactly the same arguments/key and preview=false. Mandatory owner approval cannot be bypassed by the Docs replacement setting. Strings are literal. Sheets offers no revision/CAS guard; comparison cannot eliminate concurrent overwrites. Only verified confirms bounded readback after an acknowledged response. After uncertainty inspect the SAME account/key; never retry, replace the key, roll back or force-unlock. No real provider writes for testing without specific authorization.' : undefined,
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
