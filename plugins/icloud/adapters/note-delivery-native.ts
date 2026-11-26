import { CloudError } from '../core/ports.ts';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { NoteDeliveryQueue, NoteDeliveryPlan } from './note-delivery-queue.ts';
import { classifyReplacementReadback, deliveryObservation, type DeliveryObservation, type NoteDeliveryRecovery } from './note-delivery-recovery.ts';
import { NoteDeliveryPump, type NativePublicationResult, type PublicationIntent, type NotePublicationWorker } from './note-delivery-pump.ts';
import type { ManagedNativeMirror, RcloneProcess } from './rclone-process.ts';

const string = z.string().min(1).max(512);
const identity = z.strictObject({ documentId: string, parentId: string, etag: string });
const index = z.strictObject({ version: z.literal(1), binding: string, notes: z.record(z.string(), identity) });
const reply = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('observed'), observation: deliveryObservation }),
  z.strictObject({ outcome: z.literal('published'), observation: deliveryObservation, sourceRetained: z.literal(true).optional() }),
  z.strictObject({ outcome: z.literal('conflict_preserved'), conflictCopy: z.string().max(1024) }),
  z.strictObject({ outcome: z.literal('conflict_resolved') }),
  z.strictObject({ outcome: z.literal('conflict_resolution_pending') }),
  z.strictObject({ outcome: z.literal('conflict_paths_differ') }),
  z.strictObject({ outcome: z.literal('refused') }),
  z.strictObject({ outcome: z.literal('absent') }),
  z.strictObject({ outcome: z.literal('uncertain') }),
]);
const indexLimit = 16 << 20;
type LocalNote = { text: string; hash: string };

export async function readNativeIndex(target: ManagedNativeMirror, path: string) {
  const input = await open(join(target.workdir,'bb-cloud-note-identities-v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > indexLimit) return null;
    const bytes = Buffer.alloc(info.size + 1);
    const {bytesRead} = await input.read(bytes,0,bytes.length,0);
    if (bytesRead !== info.size) return null;
    const value = index.safeParse(JSON.parse(bytes.subarray(0,bytesRead).toString()));
    return value.success && value.data.binding === target.binding && Object.hasOwn(value.data.notes,path) ? value.data.notes[path] ?? null : null;
  } finally { await input.close(); }
}

export class NativeNoteDelivery implements NotePublicationWorker {
  private readonly admitted = new Map<string, DeliveryObservation>();
  readonly acknowledgedBinding: string;
  constructor(private readonly target: ManagedNativeMirror,
    private readonly worker: Pick<RcloneProcess, 'noteDeliveryCommand'>,
    private readonly journal: NoteDeliveryRecovery,
    private readonly readLocal: (path: string) => Promise<LocalNote | null>,
  ) { this.acknowledgedBinding = target.binding; }

  async prepare(mirrorId: string, plan: NoteDeliveryPlan): Promise<PublicationIntent | 'already_present' | null> {
    if ((await this.readLocal(plan.path))?.hash !== plan.hash) return null;
    const source = plan.source ?? plan.path;
    if (plan.source && (plan.previousHash === null || await this.readLocal(source))) return null;
    const indexed = await readNativeIndex(this.target,source).catch(() => null);
    const evidence = plan.source
      ? reply.parse(await this.worker.noteDeliveryCommand(this.target,'inspect-relocation',{source,path:plan.path}))
      : await this.callInspect(source);
    const current = evidence.outcome === 'observed' ? evidence.observation : null;
    if (!plan.source && current && current.hash === plan.hash && indexed && current.documentId === indexed.documentId &&
        current.parentId === indexed.parentId && current.etag === indexed.etag) return 'already_present';
    if (plan.previousHash === null)
      return evidence.outcome === 'absent' ? {mirrorId,path:plan.path,expected:null,wantedHash:plan.hash,operations:plan.operations} : null;
    const head = this.journal.head(mirrorId,source,this.target.binding);
    const targets = head?.hash === plan.previousHash ? [head,indexed] : [indexed];
    if (!current || current.hash !== plan.previousHash || !targets.some(prior => prior && current.documentId === prior.documentId &&
        current.parentId === prior.parentId && current.etag === prior.etag)) return null;
    return { mirrorId, path:plan.path, ...(plan.source ? {source:plan.source} : {}),
      ...(plan.sourceOperations ? {sourceOperations:plan.sourceOperations} : {}),
      expected:current, wantedHash:plan.hash, operations:plan.operations };
  }

  private async callInspect(path:string) {
    return reply.parse(await this.worker.noteDeliveryCommand(this.target,'inspect',{path}));
  }

  async readBack(intent: PublicationIntent) {
    if (intent.source) {
      const recovered = await this.relocate(intent, true);
      return recovered.outcome === 'published' ? recovered.observation : null;
    }
    const inspected = await this.callInspect(intent.path);
    const current = inspected.outcome === 'observed' ? inspected.observation : null;
    if (intent.expected) {
      const evidence = classifyReplacementReadback(intent.expected,intent.wantedHash,current);
      if (evidence.outcome !== 'published' && evidence.outcome !== 'unchanged') return current;
    } else if (inspected.outcome !== 'absent' && current?.hash !== intent.wantedHash) return null;
    const recovered = await this.send(intent.expected ? 'recover' : 'recover-create',intent);
    return recovered.outcome === 'published' ? recovered.observation : null;
  }

  private async observeConflictResolution(intent: PublicationIntent, approve: boolean) {
    const expected = intent.expected;
    if (!intent.source || !expected) throw new CloudError('invalid_selection');
    return reply.parse(await this.worker.noteDeliveryCommand(this.target,
      approve ? 'reconcile-relocation' : 'read-relocation-resolution',{
        source:intent.source,path:intent.path,operationId:intent.operations.at(-1)!,wantedHash:intent.wantedHash,
        expected:{documentId:expected.documentId,parentId:expected.parentId,etag:expected.etag,hash:expected.hash},
      })).outcome;
  }

  async requestConflictResolution(intent: PublicationIntent) { return this.observeConflictResolution(intent,true); }
  async conflictResolutionApplied(intent: PublicationIntent) { return await this.observeConflictResolution(intent,false) === 'conflict_resolved'; }

  async publish(intent: PublicationIntent) {
    return intent.source ? this.relocate(intent, false) : this.send(intent.expected ? 'replace' : 'create',intent);
  }

  private async relocate(intent: PublicationIntent, recovering: boolean): Promise<NativePublicationResult> {
    const expected = intent.expected;
    if (!intent.source || !expected) return {outcome:'refused'};
    const local = await this.readLocal(intent.path);
    const text = local?.hash === intent.wantedHash && !await this.readLocal(intent.source) ? local.text : undefined;
    if (!recovering && text === undefined) return {outcome:'refused'};
    const operationId = intent.operations.at(-1)!;
    const result = reply.parse(await this.worker.noteDeliveryCommand(this.target,'relocate',{
      source:intent.source,path:intent.path,operationId,wantedHash:intent.wantedHash,...(text !== undefined ? {text} : {}),
      expected:{documentId:expected.documentId,parentId:expected.parentId,etag:expected.etag,hash:expected.hash},
    }));
    if (result.outcome === 'conflict_preserved') {
      this.journal.preserveMoveConflict(intent.mirrorId,operationId,result.conflictCopy);
      return {outcome:'uncertain'};
    }
    if (result.outcome === 'refused') return {outcome:'refused'};
    if (result.outcome !== 'published') return {outcome:'uncertain'};
    this.admitted.set(operationId,result.observation);
    return result;
  }

  private async send(operation: 'replace' | 'recover' | 'create' | 'recover-create', intent: PublicationIntent): Promise<NativePublicationResult> {
    const local = await this.readLocal(intent.path);
    if (!local || local.hash !== intent.wantedHash) return {outcome:operation === 'replace' || operation === 'create' ? 'refused' : 'uncertain'};
    const operationId = intent.operations.at(-1)!;
    const expected = intent.expected && identity.extend({hash:z.string()}).parse({
      documentId:intent.expected.documentId,parentId:intent.expected.parentId,etag:intent.expected.etag,hash:intent.expected.hash,
    });
    const result = reply.parse(await this.worker.noteDeliveryCommand(this.target, operation,
      {path:intent.path,operationId,...(expected ? {expected} : {}),text:local.text}));
    if (result.outcome === 'refused') return {outcome:'refused'};
    if (result.outcome !== 'published') return {outcome:'uncertain'};
    this.admitted.set(operationId,result.observation);
    return result;
  }

  async reconcile(intent: PublicationIntent, publication: DeliveryObservation) {
    // The event is already durable in the BB journal or originated from this
    // native command, before the scan can apply any stale observation.
    const proof = this.admitted.get(intent.operations.at(-1)!);
    if (proof && (proof.documentId !== publication.documentId || proof.etag !== publication.etag))
      throw new Error('native note receipt changed');
  }
}

export async function runNoteDelivery(mirrorId: string,target: ManagedNativeMirror,worker: RcloneProcess,queue: NoteDeliveryQueue,
  journal: NoteDeliveryRecovery,readLocal: (path: string) => Promise<LocalNote | null>, path?:string) {
  return new NoteDeliveryPump(queue,journal,new NativeNoteDelivery(target,worker,journal,readLocal)).deliverOne(mirrorId,path);
}
