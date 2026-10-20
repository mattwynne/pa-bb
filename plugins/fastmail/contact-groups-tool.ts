import { z } from 'zod';
import { ContactGroupsError, createConfiguredService } from './contact-groups.js';

const exactText = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/, 'Use an exact name or identifier without control characters.');
export const contactGroupSchema = z.object({
  action: z.enum(['list', 'get', 'add', 'remove']),
  group: exactText.optional().describe('Exact group name or CardDAV UID from list, required except for list. Duplicate names require a unique UID.'),
  email: z.string().min(3).max(320).regex(/^[^\s\x00-\x1f\x7f]+@[^\s\x00-\x1f\x7f]+$/).optional().describe('One exact address of an existing contact; no plus-address or domain normalization.'),
  contactUid: exactText.optional().describe('CardDAV vCard UID, not an MCP contact ID. Use to disambiguate contacts.'),
  apply: z.boolean().optional().describe('Only true applies an explicitly requested add/remove. Omit for preview.'),
}).strict().superRefine((args, ctx) => {
  if (args.action !== 'list' && !args.group) ctx.addIssue({ code: 'custom', message: 'group is required.', path: ['group'] });
  if (['add', 'remove'].includes(args.action) && !(args.email || args.contactUid)) ctx.addIssue({ code: 'custom', message: 'email or contactUid is required.', path: ['email'] });
  if (args.apply && !['add', 'remove'].includes(args.action)) ctx.addIssue({ code: 'custom', message: 'apply is only valid for add/remove.', path: ['apply'] });
});

export async function runContactGroups(
  config: { username?: string; appPassword?: string },
  args: z.infer<typeof contactGroupSchema>,
  options: { signal?: AbortSignal; fetchImplementation?: typeof fetch; diagnose: (stage: string, category: string) => void },
) {
  try {
    const result = await createConfiguredService(config, options).execute(args);
    let text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') > 32_000) {
      text = JSON.stringify({ summary: 'CardDAV result exceeds the output limit. Inspect the contact/group in Fastmail before another change.',
        truncated: true, applied: result.applied ?? false, verified: result.verified ?? false,
        wouldChange: result.wouldChange ?? false, isMember: result.isMember });
    }
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    // Categories originate in our service, never from provider errors or abort reasons.
    options.diagnose('carddav_tool', error instanceof ContactGroupsError ? error.category : 'unknown');
    return { content: [{ type: 'text' as const, text: error instanceof ContactGroupsError ? error.message
      : 'CardDAV call did not complete. A write may have completed; inspect live membership with get or in Fastmail before retrying. No automatic retry.' }], isError: true };
  }
}
