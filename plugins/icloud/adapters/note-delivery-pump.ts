import { coalesceDelivery, type NoteDeliveryQueue, type NoteDeliveryPlan } from './note-delivery-queue.ts';
import { classifyReplacementReadback, type DeliveryIntent, type DeliveryObservation, type NoteDeliveryRecovery } from './note-delivery-recovery.ts';

export type PublicationIntent = DeliveryIntent;
export type NativePublicationResult =
  | { outcome: 'published'; observation: DeliveryObservation }
  | { outcome: 'refused' }
  | { outcome: 'uncertain' };

export interface NotePublicationWorker {
  // The approved identity may only come from a prior confirmed scan/receipt.
  // Read exact local bytes and compare their hash before returning a plan.
  prepare(mirrorId: string, plan: NoteDeliveryPlan): Promise<PublicationIntent | 'already_present' | null>;
  readBack(intent: PublicationIntent): Promise<DeliveryObservation | null>;
  publish(intent: PublicationIntent): Promise<NativePublicationResult>;
  // Acknowledgement requires a durable publication receipt in the native
  // worker. The scan will incorporate that receipt under its mutation lock.
  reconcile(intent: PublicationIntent, publication: DeliveryObservation): Promise<void>;
  acknowledgedBinding?: string;
}

export class NoteDeliveryPump {
  constructor(private readonly queue: NoteDeliveryQueue, private readonly journal: NoteDeliveryRecovery, private readonly worker: NotePublicationWorker) {}

  // The owning worker serializes calls for a mirror and supplies a bounded turn.
  async deliverOne(mirrorId: string, path?: string) {
    const pending = this.journal.pending(mirrorId);
    if (pending) {
      if (pending.publication) return this.finish(pending,pending.publication);
      const current = await this.worker.readBack(pending);
      if (!current || current.hash !== pending.wantedHash ||
          (pending.expected && !pending.source && classifyReplacementReadback(pending.expected,pending.wantedHash,current).outcome !== 'published'))
        return 'needs_reconciliation' as const;
      return this.accept(pending,current);
    }

    const queued = path === undefined ? this.queue.oldest(mirrorId) : this.queue.pendingPath(mirrorId,path);
    if (queued.length === 0) return 'idle' as const;
    let plan = coalesceDelivery(queued);
    if (!plan) return 'needs_reconciliation' as const;
    if (plan.source) {
      const source = this.queue.pendingPath(mirrorId,plan.source).filter(row => row.sequence < queued[0]!.sequence);
      if (source.length) {
        const prior = coalesceDelivery(source);
        if (!prior || prior.source || prior.previousHash === null || prior.hash !== plan.previousHash)
          return 'needs_reconciliation' as const;
        plan = { ...plan, previousHash:prior.previousHash, sourceOperations:prior.operations };
      }
    }
    const replacement = await this.worker.prepare(mirrorId, plan);
    if (replacement === 'already_present') {
      this.queue.settle(mirrorId,plan.path,plan.operations);
      return 'delivered' as const;
    }

    if (!replacement || replacement.mirrorId !== mirrorId || replacement.path !== plan.path || replacement.source !== plan.source ||
      replacement.operations.length !== plan.operations.length ||
      replacement.operations.some((operation, i) => operation !== plan.operations[i]) ||
      (replacement.expected?.hash ?? null) !== plan.previousHash || replacement.wantedHash !== plan.hash)
      return 'needs_reconciliation' as const;
    this.journal.prepare(replacement);
    const published = await this.worker.publish(replacement);
    if (published.outcome === 'refused') {
      this.journal.refused(mirrorId, replacement.operations.at(-1)!);
      return 'needs_reconciliation' as const;
    }
    if (published.outcome === 'uncertain') return 'needs_reconciliation' as const;
    return this.accept(replacement, published.observation);
  }

  private accept(intent: PublicationIntent, publication: DeliveryObservation) {
    this.journal.published(intent.mirrorId,intent.operations.at(-1)!,publication,
      intent.expected === null ? publication.documentId : undefined);
    return this.finish(intent, publication);
  }

  private async finish(intent: PublicationIntent, publication: DeliveryObservation) {
    await this.worker.reconcile(intent, publication);
    this.journal.reconciled(intent.mirrorId, intent.operations.at(-1)!, publication.documentId, publication.etag, this.queue, this.worker.acknowledgedBinding);
    return 'delivered' as const;
  }
}
