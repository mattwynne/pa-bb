import { z } from 'zod';
import { relativeFolder } from '../adapters/obsidian.ts';
import { reference } from '../contract.ts';

const notePath = relativeFolder.refine(path => path.endsWith('.md'));
const threadChoice = z.object({
  threadId: z.string().min(1).max(128),
  kind: z.enum(['project', 'area']),
  expected: reference,
  targetPath: notePath,
}).strict();
const migrationChoices = z.object({
  areaAssignments: z.array(z.object({
    projectPath: notePath,
    expectedDeclaration: z.json(),
    targetAreaPath: notePath,
  }).strict()).max(200).default([]),
  threadReassignments: z.array(threadChoice).max(200).default([]),
}).strict();
export type MigrationChoices = z.infer<typeof migrationChoices>;

const messages = {
  invalid_input: 'Supply a JSON review with exact paths and expected references, up to 16 KiB.',
  coverage: 'Explicit choices require complete inventory, note and thread evidence.',
  duplicate: 'Each project path and each thread and kind pair can appear only once.',
  conflict: 'An explicit choice overlaps a receipt-based mapping. Use one source of evidence for that reference.',
  area_assignment: 'An Area choice has a missing or changed declaration, an unavailable project, or an invalid target Area.',
  thread_reassignment: 'A thread choice has a missing or changed reference, a different source, or an invalid target record.',
};
export class InvalidMigrationChoices extends Error {
  constructor(readonly reason: keyof typeof messages) { super(messages[reason]); }
}

export const threadChoiceKey = ({threadId, kind}: Pick<z.infer<typeof threadChoice>, 'threadId' | 'kind'>) =>
  JSON.stringify([threadId, kind]);

export function parseMigrationChoices(input: string | undefined): MigrationChoices | undefined {
  if (input === undefined) return;
  if (Buffer.byteLength(input) > 16 * 1024) throw new InvalidMigrationChoices('invalid_input');
  let choices: MigrationChoices;
  try { choices = migrationChoices.parse(JSON.parse(input)); }
  catch { throw new InvalidMigrationChoices('invalid_input'); }
  if (new Set(choices.areaAssignments.map(choice => choice.projectPath)).size !== choices.areaAssignments.length ||
      new Set(choices.threadReassignments.map(threadChoiceKey)).size !== choices.threadReassignments.length)
    throw new InvalidMigrationChoices('duplicate');
  return choices.areaAssignments.length || choices.threadReassignments.length ? choices : undefined;
}
