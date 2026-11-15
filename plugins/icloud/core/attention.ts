export const DAY = 86_400_000;
export type ConnectionIssue = 'authentication' | 'provider_rejected';
export type AttentionState = { issue: ConnectionIssue | null; revision: number; snoozedUntil: string | null; snoozedStage: string | null; deliveredGeneration: string | null };
export type Attention = { stage: 'reminder' | ConnectionIssue; generation: string; snoozedUntil: string | null };
export const emptyAttention = (): AttentionState => ({ issue: null, revision: 0, snoozedUntil: null, snoozedStage: null, deliveredGeneration: null });
export function verifiedDate(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now && new Date(time).toISOString() === value ? value : null;
}
export function attentionSnapshot(state: AttentionState, completed: unknown, now: number): Attention | null {
  const date = verifiedDate(completed, now);
  const age = date ? now - Date.parse(date) : 0;
  const stage = state.issue ?? (date && age >= 25 * DAY ? 'reminder' : null);
  if (!stage) return null;
  const generation = stage === 'reminder' ? `reminder:${date}:${Math.floor((age - 25 * DAY) / DAY)}` : `${stage}:${state.revision}`;
  const snooze = verifiedDate(state.snoozedUntil, now + DAY);
  return { stage, generation, snoozedUntil: state.snoozedStage === stage && snooze && Date.parse(snooze) > now ? snooze : null };
}
export function loadAttention(value: AttentionState | undefined): AttentionState {
  return { ...emptyAttention(), issue: value?.issue === 'authentication' || value?.issue === 'provider_rejected' ? value.issue : null,
    revision: Number.isSafeInteger(value?.revision) && value!.revision >= 0 ? value!.revision : 0,
    snoozedUntil: typeof value?.snoozedUntil === 'string' ? value.snoozedUntil : null,
    snoozedStage: ['reminder', 'authentication', 'provider_rejected'].includes(value?.snoozedStage ?? '') ? value!.snoozedStage : null,
    deliveredGeneration: typeof value?.deliveredGeneration === 'string' && value.deliveredGeneration.length < 160 ? value.deliveredGeneration : null };
}
