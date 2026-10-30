// Task consent is invocation-local and bound to exact persisted child proposals.
// Each mutation keeps its own single-use receipt, claim, revalidation and recovery.
import { z } from 'zod';
import { folderParameters, moveParameters, filingError, filingHash } from './filing.mjs';
export const makeFilingTaskParameters = () => z.object({
  account: z.string().trim().min(1).max(320),
  operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  preview: z.boolean().default(true),
  items: z.array(z.discriminatedUnion('kind', [
    folderParameters.omit({ account: true, preview: true }).extend({ kind: z.literal('folder') }),
    moveParameters.omit({ account: true, preview: true }).extend({ kind: z.literal('move') }),
  ])).min(1).max(20),
}).strict();
export function createFilingTaskRunner({ operations, record, change, status, save, active, requireApproval, approve, diagnose, clock }) {
  async function taskStatus(op, account) {
    if (!active.has(op.operationId) && ['preparing', 'reviewing'].includes(op.state)) {
      // A durable task never resumes writes after losing its invocation/consent.
      await save(op, 'interrupted');
    }
    const items = [];
    for (const item of op.items) {
      const child = await operations.get(item.operationId);
      items.push(child && child.subject === op.subject ? await status({ account, operationId: item.operationId })
        : { operationId: item.operationId, outcome: 'unprepared', writeAttempted: false, retrySafe: false });
    }
    return { operationId: op.operationId, outcome: op.state, inProgress: active.has(op.operationId) && ['preparing', 'reviewing'].includes(op.state), retrySafe: false, items,
      guidance: 'Task recovery never submits provider writes. Inspect individual receipts, including unprepared/unstarted items. A task is not atomic; never replay or replace keys after interruption.' };
  }
  async function run(input, signal, requestApproval = approve) {
    const parsed = makeFilingTaskParameters().safeParse(input);
    if (!parsed.success) throw filingError('invalid');
    const { account, operationId, preview, items } = parsed.data;
    if (new Set([operationId, ...items.map(i => i.operationId)]).size !== items.length + 1
      || new Set(items.map(i => i.kind === 'move' ? `file:${i.fileId}` : `folder:${i.parentId}:${i.name}`)).size !== items.length) throw filingError('invalid');
    const r = await record({ account }), requestHash = filingHash(items);
    let op = await operations.get(operationId);
    if (op && (op.subject !== r.subject || op.requestHash !== requestHash || op.kind !== 'task')) throw filingError('conflict');
    if (op && op.state !== 'proposed') return taskStatus(op, account);
    if (!op) {
      for (const item of items) if (await operations.get(item.operationId)) throw filingError('conflict');
      // Reserve the task before preparing any child so failed previews are inspectable.
      op = { kind: 'task', operationId, subject: r.subject, requestHash, resource: `task:${operationId}`,
        state: 'preparing', createdAt: clock(), items, proposals: [], contextIds: [] };
      if (!await operations.reserve(op)) throw filingError('busy');
      active.add(operationId);
      try {
        for (const { kind, ...item } of items) {
          signal?.throwIfAborted();
          op.proposals.push(await change(kind, { ...item, account, preview: true }, signal));
          await save(op, 'preparing');
        }
        op.payload = { kind: 'task', account: r.email, operationId,
          items: op.proposals.map(p => ({ ...p.preview, operationId: p.operationId, requiresApproval: p.requiresApproval })) };
        if (Buffer.byteLength(JSON.stringify(op.payload), 'utf8') > 64_000) throw filingError('unsupported');
        await save(op, 'proposed');
      } catch (error) {
        diagnose('filing_task_preview', error);
        await save(op, 'not_submitted');
        return taskStatus(op, account);
      } finally { active.delete(operationId); }
    }
    if (preview) return { operationId, outcome: 'proposed', items: op.proposals, retrySafe: false };
    if (clock() - op.createdAt >= 600_000) { await save(op, 'expired'); return taskStatus(op, account); }
    if (!await operations.claim(op)) throw filingError('busy');
    op.state = 'reviewing'; active.add(operationId);
    try {
      signal?.throwIfAborted();
      const policyRequiresApproval = await requireApproval();
      let reviewedByOwner = false;
      if (op.proposals.some(p => p.requiresApproval) && policyRequiresApproval) {
        const d = await requestApproval(op.payload, signal);
        if (d?.outcome !== 'submitted' || d.value?.approved !== true || Object.keys(d.value).length !== 1) {
          diagnose('filing_task_approval_cancelled', null);
          await save(op, d?.outcome === 'submitted' && d.value?.approved === false ? 'declined' : 'cancelled');
          return taskStatus(op, account);
        }
        reviewedByOwner = true;
      }
      const results = [];
      for (const { kind, ...item } of items) {
        signal?.throwIfAborted();
        const child = await operations.get(item.operationId);
        const original = op.proposals.find(p => p.operationId === item.operationId);
        if ((!policyRequiresApproval && await requireApproval()) || clock() - op.createdAt >= 600_000
          || !child || child.state !== 'proposed' || filingHash(child.preview) !== filingHash(original.preview)) break;
        const result = await change(kind, { ...item, account, preview: false }, signal,
          // Tightening Never cannot synthesize owner consent; change also checks
          // policy at its final submission boundary.
          async () => reviewedByOwner ? { outcome: 'submitted', value: { approved: true } } : { outcome: 'cancelled' });
        results.push(result);
        if (result.outcome !== 'verified') break;
      }
      await save(op, results.length === items.length && results.every(p => p.outcome === 'verified') ? 'verified' : 'partial');
      if (op.state === 'partial') diagnose('filing_task_partial', null);
      return taskStatus(op, account);
    } catch (error) {
      diagnose('filing_task', error);
      await save(op, 'partial');
      return taskStatus(op, account);
    } finally { active.delete(operationId); }
  }
  return { run, status: taskStatus };
}
