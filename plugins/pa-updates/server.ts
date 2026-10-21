import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { rpcContract } from './contract.ts';
import { Updates } from './core/service.ts';
import { categorySchema } from './core/model.ts';
import type { Ports, Stage } from './core/model.ts';
import { githubFeed } from './adapters/github.ts';
import { installedInventory } from './adapters/inventory.ts';
import { localGit } from './adapters/local-git.ts';
import { Application } from './core/application.ts';
import type { ApplicationPorts } from './core/application.ts';
import { applicationPorts } from './adapters/application.ts';
export default async function plugin(bb: BbPluginApi, injected?: Partial<Ports>, applicationOverride?: ApplicationPorts) {
  const diagnose: Ports['diagnose'] = (stage, category) => {
    // Fixed allowlists are the entire diagnostic payload. No exception, Git
    // output, source path, release note or provider content enters the logger.
    const stages: Stage[] = ['feed', 'inventory', 'local', 'storage'];
    bb.log.warn(`pa-updates stage=${stages.includes(stage) ? stage : 'local'} outcome=${categorySchema.safeParse(category).success ? category : 'unavailable'}`);
  };
  const inspect = localGit(undefined); // Historical single-component RPC; current review owns canonical source inspection.
  const service = new Updates({
    feed: githubFeed(), inventory: installedInventory(bb, diagnose),
    async local(target, signal) { const result = await inspect(target, signal); if (['unavailable', 'unsupported', 'target_missing', 'limit'].includes(result.reason)) diagnose('local', 'unavailable'); return result; },
    load: () => bb.storage.kv.get('checks-v1'), save: value => bb.storage.kv.set('checks-v1', value),
    now: Date.now, diagnose, ...injected,
  }, () => bb.realtime.publish('status', null));
  const application = new Application(applicationOverride ?? applicationPorts(bb), () => bb.realtime.publish('application', null));
  await service.start(); await application.start();
  bb.onDispose(async () => { await application.dispose(); await service.stop(); });
  bb.rpc.register(rpcContract, {
    status: () => service.status(),
    applicationStatus: () => application.refresh(),
    review: async (_input, context) => {
      if (context.experimental_caller.kind !== 'client') throw new Error('Use Review in PA updates.');
      await service.check(true); return application.review();
    },
    resumeSync: (_input, context) => {
      if (context.experimental_caller.kind !== 'client') throw new Error('Use Resume in PA updates.');
      return application.resumeSync();
    },
    apply: async (input, context) => {
      if (context.experimental_caller.kind !== 'client') throw new Error('Use Update PA in settings.');
      try { return await application.apply(input); }
      catch { throw new Error('The review is no longer ready. Check again before updating.'); }
    },
    check: (_input, context) => {
      if (context.experimental_caller.kind !== 'client') throw new Error('Use Check again in PA updates.');
      return service.check(true);
    },
  });
  bb.background.schedule('release-discovery', '0 */6 * * *', async () => { await application.refresh(); await service.check(false); await application.review({ automatic: true }); });
  bb.background.service('initial-discovery', { async start(signal) {
    const stop = () => { void application.dispose(); void service.stop(); };
    signal.addEventListener('abort', stop, { once: true });
    try { if (!signal.aborted) await application.refresh(); if (!signal.aborted) await service.check(false); if (!signal.aborted) await application.review({ automatic: true }); }
    finally { signal.removeEventListener('abort', stop); }
  } });
}
