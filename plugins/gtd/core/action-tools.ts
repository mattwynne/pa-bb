import { cliCommand, PluginCliError, type BbPluginApi } from '@get-bb/plugin-sdk';
import type { z } from 'zod';
import { actionInputs, actionToolNames, type ActionChange, type ActionTarget, type listActions } from './actions.ts';
import type { standardSaveResult } from '../contract.ts';

type WriteResult = z.infer<typeof standardSaveResult> | {
  outcome: 'unchanged' | 'not_saved';
  reason?: 'missing_action' | 'nested_actions' | 'invalid_section' | 'changed';
};
type Ports = {
  list(input: ActionTarget, signal: AbortSignal): Promise<{ version: string; actions: ReturnType<typeof listActions> }>;
  change(input: ActionChange, signal: AbortSignal): Promise<WriteResult>;
};

const messages = {
  changed: 'The note changed. List its actions again before editing or deleting.',
  missing_action: 'That line does not identify an action. List the actions again.',
  nested_actions: 'Remove or move the actions nested under this one before deleting it.',
  invalid_section: 'Check the TODO section’s formatting and size in Obsidian.',
};
const readError = 'Could not read the TODO section. Check the GTD reference and the note in Obsidian.';
const writeError = 'Could not prepare the action change. Check the GTD reference and the TODO section in Obsidian.';

export function registerActionTools(bb: BbPluginApi, ports: Ports) {
  function register<T>(name: string, parameters: z.ZodType<T>, description: string,
    execute: (input: T, signal: AbortSignal) => Promise<unknown>, failure: string) {
    bb.agents.registerTool({ name, parameters, description, async execute(input, context) {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await execute(input, context.signal)) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: failure }] };
      }
    } });
  }
  const target = 'Use the kind and exact source and note ID returned by GTD inventory.';
  const version = 'Use the line and version from gtd_list_actions. List again after a confirmed change. Inspect the returned operation ID before retrying an uncertain save.';
  register(actionToolNames[0], actionInputs.list, `List checkbox actions in a project or Area’s Obsidian TODO section. ${target}`, ports.list, readError);
  register(actionToolNames[1], actionInputs.add, `Add an explicitly requested unchecked action to a project or Area’s Obsidian TODO section, creating the section if needed. ${target} Inspect the returned operation ID before retrying an uncertain save.`,
    (input, signal) => ports.change({ ...input, operation: 'add' }, signal), writeError);
  register(actionToolNames[2], actionInputs.edit, `On request, edit an action’s text or completion status. ${target} ${version}`,
    (input, signal) => ports.change({ ...input, operation: 'edit' }, signal), writeError);
  register(actionToolNames[3], actionInputs.delete, `Delete one explicitly requested checkbox action from a project or Area’s Obsidian TODO section. ${target} ${version}`,
    (input, signal) => ports.change({ ...input, operation: 'delete' }, signal), writeError);
}

export function actionCommands(ports: Ports) {
  const target = {
    kind: { type: 'enum', values: ['project', 'area'], required: true, description: 'Kind of GTD note' },
    source: { type: 'string', required: true, description: 'Exact vault source ID from GTD inventory' },
    id: { type: 'string', required: true, description: 'Exact Markdown note ID from GTD inventory' },
    json: { type: 'boolean', description: 'Emit structured results' },
  } as const;
  const identity = {
    ...target,
    line: { type: 'integer', min: 1, max: 16000, required: true, description: 'Action line within TODO, returned by actions list' },
    version: { type: 'string', required: true, description: 'Note version returned by actions list' },
  } as const;
  const text = { type: 'string', description: 'Single line of action text' } as const;
  const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const result = schema.safeParse(input);
    if (!result.success) throw new PluginCliError('Invalid action options. Check the command’s help.', { code: 'invalid_input' });
    return result.data;
  };
  const write = async (input: ActionChange, json: boolean | undefined, signal: AbortSignal) => {
    let result: WriteResult;
    try { result = await ports.change(input, signal); }
    catch { throw new PluginCliError(writeError, { code: 'source_unavailable' }); }
    const { outcome, reason } = result;
    const operation = 'operationId' in result ? ` Operation ID: ${result.operationId}` : '';
    const message = outcome === 'saved_locally_pending_sync' ? 'Action saved locally in Obsidian.'
      : outcome === 'unchanged' ? 'Action already matches.'
        : outcome === 'uncertain' ? 'Save unconfirmed. Inspect its receipt before trying again.'
          : reason ? messages[reason] : 'Could not save the action.';
    return { exitCode: outcome === 'not_saved' || outcome === 'uncertain' ? 1 : 0,
      stdout: json ? JSON.stringify(result) : message + operation };
  };
  return {
    'actions list': cliCommand({ summary: 'List checkbox actions from a GTD note’s TODO section', options: target, async run(input, context) {
      const { json, ...options } = input.options;
      const query = parse(actionInputs.list, options);
      try {
        const result = await ports.list(query, context.signal ?? AbortSignal.timeout(30000));
        const lines = result.actions.map(action => `${action.line}. [${action.complete ? 'x' : ' '}] ${action.text}`);
        return { exitCode: 0, stdout: json ? JSON.stringify(result) : [...(lines.length ? lines : ['No actions recorded.']), `Version: ${result.version}`].join('\n') };
      } catch { throw new PluginCliError(readError, { code: 'source_unavailable' }); }
    } }),
    'actions add': cliCommand({ summary: 'Add an unchecked action', options: { ...target, text: { ...text, required: true } }, async run(input, context) {
      const { json, ...options } = input.options;
      return write({ ...parse(actionInputs.add, options), operation: 'add' }, json, context.signal ?? AbortSignal.timeout(30000));
    } }),
    'actions edit': cliCommand({ summary: 'Edit action text or completion status', options: {
      ...identity, text, status: { type: 'enum', values: ['open', 'complete'], description: 'Set the checkbox status' },
    }, async run(input, context) {
      const { json, status, ...options } = input.options;
      return write({ ...parse(actionInputs.edit, { ...options, ...(status ? { complete: status === 'complete' } : {}) }), operation: 'edit' }, json, context.signal ?? AbortSignal.timeout(30000));
    } }),
    'actions delete': cliCommand({ summary: 'Delete a checkbox action', options: identity, async run(input, context) {
      const { json, ...options } = input.options;
      return write({ ...parse(actionInputs.delete, options), operation: 'delete' }, json, context.signal ?? AbortSignal.timeout(30000));
    } }),
  };
}
