// Shared input/approval contract. No Node/provider code: safe for the UI bundle.
import { z } from 'zod';
export const pageFormat = z.object({
  tabId: z.string().min(1).max(256),
  size: z.literal('LETTER').optional(),
  marginTopPt: z.number().min(18).max(144).optional(),
  marginBottomPt: z.number().min(18).max(144).optional(),
  marginLeftPt: z.number().min(18).max(144).optional(),
  marginRightPt: z.number().min(18).max(144).optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Opaque page colour #RRGGBB for this explicit tab. Omitted preserves the current background; no alpha, transparency or paragraph shading.'),
}).strict().refine(p => Object.entries(p).some(([key, value]) => key !== 'tabId' && value !== undefined), 'Specify at least one page property.');
