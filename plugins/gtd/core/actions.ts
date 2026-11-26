import { fromMarkdown } from 'mdast-util-from-markdown';
import { z } from 'zod';
import { reference, standardTextLimit } from '../contract.ts';

export const actionTarget = reference.extend({ kind: z.enum(['project', 'area']) });
const actionText = z.string().trim().min(1).max(2000).regex(/^[^\u0000-\u001f\u007f]+$/u);
const actionIdentity = actionTarget.extend({
  line: z.number().int().min(1).max(standardTextLimit),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
const addAction = actionTarget.extend({ text: actionText });
const editAction = actionIdentity.extend({ text: actionText.optional(), complete: z.boolean().optional() })
  .refine(input => input.text !== undefined || input.complete !== undefined, 'Supply text or completion status.');

export const actionInputs = { list: actionTarget, add: addAction, edit: editAction, delete: actionIdentity };
export const actionToolNames = ['gtd_list_actions', 'gtd_add_action', 'gtd_edit_action', 'gtd_delete_action'] as const;
export type ActionTarget = z.infer<typeof actionTarget>;
export type ActionChange =
  | ({ operation: 'add' } & z.infer<typeof addAction>)
  | ({ operation: 'edit' } & z.infer<typeof editAction>)
  | ({ operation: 'delete' } & z.infer<typeof actionIdentity>);

type Action = { line: number; text: string; complete: boolean };
type ActionSpan = { action: Action; itemStart: number; itemEnd: number; markerStart: number; textStart: number; lineEnd: number };

function actionSpans(section: string) {
  const spans: ActionSpan[] = [];
  const tree = fromMarkdown(section);
  const nodes = [...tree.children];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.type === 'listItem' && node.children[0]?.type === 'paragraph') {
      const paragraph = node.children[0].position;
      const markerStart = paragraph?.start.offset;
      const itemStart = node.position?.start.offset;
      const itemEnd = node.position?.end.offset;
      if (paragraph && markerStart !== undefined && itemStart !== undefined && itemEnd !== undefined) {
        const end = section.indexOf('\n', markerStart);
        const lineEnd = end === -1 ? section.length : end - Number(section[end - 1] === '\r');
        const match = /^\[([^\]\r\n])\][ \t]+(\S.*)$/u.exec(section.slice(markerStart, lineEnd));
        if (match) spans.push({
          action: { line: paragraph.start.line, text: match[2].trimEnd(), complete: !!match[1].trim() },
          itemStart, itemEnd, markerStart, lineEnd, textStart: lineEnd - match[2].length,
        });
      }
    }
    if ('children' in node && node.type !== 'blockquote') nodes.push(...node.children);
  }
  return spans.sort((left, right) => left.itemStart - right.itemStart);
}

export function listActions(section: string) {
  return actionSpans(section).map(span => span.action);
}

export function changeActions(section: string, change: ActionChange) {
  const newline = section.includes('\r\n') ? '\r\n' : '\n';
  if (change.operation === 'add') return { text: '- [ ] ' + change.text + (section ? newline + newline + section : '') };

  const spans = actionSpans(section);
  const span = spans.find(span => span.action.line === change.line);
  if (!span) return { reason: 'missing_action' as const };
  if (change.operation === 'delete') {
    if (spans.some(other => other.itemStart > span.itemStart && other.itemStart < span.itemEnd))
      return { reason: 'nested_actions' as const };
    const start = span.itemStart === 0 ? 0 : section.lastIndexOf('\n', span.itemStart - 1) + 1;
    const end = section.indexOf('\n', span.itemEnd);
    return { text: section.slice(0, start) + section.slice(end === -1 ? section.length : end + 1) };
  }

  const marker = change.complete === undefined || change.complete === span.action.complete
    ? section[span.markerStart + 1] : change.complete ? 'x' : ' ';
  const original = section.slice(span.textStart, span.lineEnd);
  const trailingSpace = original.slice(original.trimEnd().length);
  return {
    text: section.slice(0, span.markerStart + 1) + marker + section.slice(span.markerStart + 2, span.textStart)
      + (change.text === undefined ? original : change.text + trailingSpace) + section.slice(span.lineEnd),
  };
}
