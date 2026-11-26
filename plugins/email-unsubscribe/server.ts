import { createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { renderMessage } from './message.ts';
import { browserWorker, mailResultSchema, messageSchema, targetSchema, unsubscribeMessage, type Result } from './unsubscribe.ts';
import { webRequest } from './web.ts';

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    browserWorkerOrigin: { type: 'string', label: 'Browser worker HTTPS origin', default: '' },
    browserWorkerSecret: { type: 'string', label: 'Browser worker secret', secret: true },
  });
  bb.rpc.register({ status: { input: z.null(), output: z.object({ browser: z.enum(['configured', 'invalid_configuration', 'not_configured']) }) } }, {
    async status() {
      const { browserWorkerOrigin, browserWorkerSecret } = await settings.get();
      return { browser: browserWorker(browserWorkerOrigin, browserWorkerSecret) ? 'configured'
        : browserWorkerOrigin || browserWorkerSecret ? 'invalid_configuration' : 'not_configured' } as const;
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, ['CREATE TABLE IF NOT EXISTS unsubscribe_receipts (target TEXT PRIMARY KEY, result TEXT NOT NULL)']);
  const get = db.prepare('SELECT result FROM unsubscribe_receipts WHERE target = ?');
  const claim = db.prepare('INSERT OR IGNORE INTO unsubscribe_receipts (target, result) VALUES (?, ?)');
  const save = db.prepare('UPDATE unsubscribe_receipts SET result = ? WHERE target = ?');
  const clear = db.prepare('DELETE FROM unsubscribe_receipts WHERE target = ?');
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());

  const report = (result: Result) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }] });
  bb.agents.registerTool({
    name: 'email_unsubscribe',
    description: 'Unsubscribe from the mailing list associated with one exact Gmail or Fastmail message in the selected account. Tries a verified one-click POST, a web form, an optional isolated browser worker and email-based requests where available.',
    instructions: 'Use only when the user explicitly requests an unsubscribe for the exact source message. Gmail takes the connected mailbox address. Fastmail takes the authenticated JMAP account address or account ID. Do not pass a sender address or thread ID as a message ID. Report the returned status and method. Treat a request sent or unverified outcome as potentially applied. Existing Screener triage instructions govern use in that workflow.',
    parameters: targetSchema,
    async execute({ provider, account, emailId }, context) {
      const signal = AbortSignal.any([context.signal, lifetime.signal]);
      const pluginId = provider === 'gmail' ? 'google-workspace' : 'fastmail';
      const failure = (stage: string, category: string) => bb.log.warn(`Email Unsubscribe ${stage} ${category}`);
      let message;
      let key: string;
      try {
        const loaded = await bb.sdk.plugins.callRpc({
          pluginId, method: 'unsubscribeMessage', input: { account, emailId }, outputSchema: messageSchema, signal,
        });
        if (loaded.status !== 'ok') {
          failure('message_read', loaded.status);
          return report({ status: loaded.status === 'ineligible' ? 'unavailable' : 'needs_user', reason: loaded.status });
        }
        key = createHash('sha256').update(JSON.stringify([provider, loaded.mailbox.toLowerCase(), emailId])).digest('hex');
        message = await renderMessage(loaded.mime, loaded.mailbox);
        if (!message) return report({ status: 'needs_user', reason: 'too_large' });
        signal.throwIfAborted();
      } catch {
        failure('message_read', signal.aborted ? 'cancelled' : 'provider_or_render_unavailable');
        return report({ status: 'needs_user', reason: 'message_read_unavailable' });
      }
      const pending: Result = { status: 'unverified', reason: 'prior_attempt_may_have_run' };
      let admitted = false;
      try {
        const options = await settings.get();
        signal.throwIfAborted();
        const browser = browserWorker(options.browserWorkerOrigin, options.browserWorkerSecret);
        if (options.browserWorkerOrigin && !browser) failure('browser_setup', 'invalid_configuration');
        admitted = claim.run(key, JSON.stringify(pending)).changes === 1;
        if (!admitted) {
          const prior = get.get(key) as { result: string } | undefined;
          return report(prior ? JSON.parse(prior.result) as Result : pending);
        }
        const outcome = await unsubscribeMessage(message, {
          web: webRequest, browser, failure,
          send: (mail, sendSignal) => bb.sdk.plugins.callRpc({
            pluginId, method: 'sendUnsubscribeMail', input: { account, ...mail },
            outputSchema: mailResultSchema, signal: sendSignal,
          }),
        }, signal);
        // Browser handoff may follow an interaction. Keep its result when the worker was invoked.
        if (['needs_user', 'unavailable'].includes(outcome.status) && outcome.method !== 'browser') clear.run(key);
        else save.run(JSON.stringify(outcome), key);
        return report(outcome);
      } catch {
        failure('receipt', admitted ? 'write_unverified' : 'unavailable');
        return report(admitted ? pending : { status: 'needs_user', reason: 'receipt_store_unavailable' });
      }
    },
  });
  bb.agents.configure(() => ({ tools: ['email_unsubscribe'], skills: ['email-unsubscribe'] }));
}
