import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { rpcContract } from './contract.ts';
import { Application } from './core/application.ts';
import type { ApplicationPorts } from './core/application.ts';
import { applicationPorts } from './adapters/application.ts';

// The second argument is retained for existing disposable host fixtures only;
// historical single-component release discovery no longer runs here.
export default async function plugin(bb: BbPluginApi, _legacy?: unknown, applicationOverride?: ApplicationPorts) {
  const ports = applicationOverride ?? applicationPorts(bb);
  const application = new Application(ports, () => bb.realtime.publish('application', null));
  await application.start();
  bb.onDispose(() => application.dispose());
  const client = (kind: string) => { if (kind !== 'client') throw new Error('Use PA updates in Settings.'); };
  bb.rpc.register(rpcContract, {
    status: () => application.refresh(),
    installedSources: () => {
      if (!ports.installedSources) throw new Error('Installed sources unavailable. Check again in Settings.');
      return ports.installedSources();
    },
    applicationStatus: () => application.refresh(),
    review: (_input, context) => { client(context.experimental_caller.kind); return application.review(); },
    check: (_input, context) => { client(context.experimental_caller.kind); return application.review(); },
    resumeSync: (_input, context) => { client(context.experimental_caller.kind); return application.resumeSync(); },
    acknowledgeSourceRecovery: async (input, context) => {
      client(context.experimental_caller.kind);
      try { return await application.acknowledgeSourceRecovery(input); }
      catch { throw new Error('Recovery is not verified. Keep the plugin and folders paused, check the manual recovery instructions, then check recovery again.'); }
    },
    switchSource: async (input, context) => {
      client(context.experimental_caller.kind);
      try { return await application.switchSource(input); }
      catch { throw new Error('Source switch unavailable. Check again in Settings; existing work or recovery may need attention.'); }
    },
    applyLocal: async (input, context) => {
      client(context.experimental_caller.kind);
      try { return await application.applyLocal(input); }
      catch { throw new Error('Check again before applying the working copy.'); }
    },
    apply: async (input, context) => {
      client(context.experimental_caller.kind);
      try { return await application.apply(input); }
      catch { throw new Error('The review is no longer ready. Check again before updating.'); }
    },
  });
  bb.background.schedule('update-check', '0 */6 * * *', async () => { await application.refresh(); await application.review({ automatic: true }); });
  bb.background.service('initial-discovery', { async start(signal) {
    const stop = () => { void application.dispose(); };
    signal.addEventListener('abort', stop, { once: true });
    try { if (!signal.aborted) await application.refresh(); if (!signal.aborted) await application.review({ automatic: true }); }
    finally { signal.removeEventListener('abort', stop); }
  } });
}
