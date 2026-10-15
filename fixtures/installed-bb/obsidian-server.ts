// Disposable installed-BB client driver. Captures AND forwards the original
// nine registrations; no tool/service implementation is replaced.
import { z } from 'zod';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { plugin } from './production.ts';
const names = ['obsidian_status', 'obsidian_search_notes', 'obsidian_read_note', 'obsidian_get_note_metadata', 'obsidian_resolve_link', 'obsidian_list_tasks', 'obsidian_create_note', 'obsidian_edit_note', 'obsidian_update_properties'] as const;
const catalog = new Map<string, { parameters: z.ZodType; description: string; execute: (input: any, context: any) => Promise<any> }>();
const contract = defineRpcContract({
  fixtureCatalog: { input: z.null(), output: z.string().max(64000) },
  fixtureInvoke: { input: z.object({ name: z.enum(names), input: z.record(z.string(), z.json()) }).strict(), output: z.object({ isError: z.boolean(), text: z.string().max(64000) }).strict() },
});
export default async function fixture(bb: BbPluginApi) {
  const agents = new Proxy(bb.agents, { get(target, key, receiver) {
    if (key !== 'registerTool') return Reflect.get(target, key, receiver);
    return (definition: any) => {
      if (!names.includes(definition.name) || catalog.has(definition.name)) throw new Error('unexpected fixture tool catalog');
      catalog.set(definition.name, definition);
      return target.registerTool(definition);
    };
  } });
  const intercepted = new Proxy(bb, { get(target, key, receiver) { return key === 'agents' ? agents : Reflect.get(target, key, receiver); } });
  await plugin(intercepted);
  if (catalog.size !== names.length) throw new Error('missing original tool registration');
  bb.rpc.register(contract, {
    fixtureCatalog(_input, context) {
      if (context.experimental_caller.kind !== 'client') throw new Error('fixture client only');
      return JSON.stringify(names.map(name => { const tool = catalog.get(name)!; return { name, description: tool.description, inputSchema: z.toJSONSchema(tool.parameters) }; }));
    },
    async fixtureInvoke({ name, input }, context) {
      if (context.experimental_caller.kind !== 'client') throw new Error('fixture client only');
      const tool = catalog.get(name)!;
      const parsed = tool.parameters.parse(input); // Original registered Zod parameters, no forged handler input.
      const result = await tool.execute(parsed, { signal: new AbortController().signal });
      return { isError: result.isError === true, text: result.content[0].text };
    },
  });
}
