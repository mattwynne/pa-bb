import { z } from 'zod';

export const maintenanceRunId = z.uuid();

const receipt = z.object({
  runId: maintenanceRunId,
  restored: z.number().int().min(0).max(20),
  leftPaused: z.number().int().min(0).max(20),
}).strict();

export const maintenanceRecord = z.object({
  hold: z.object({ runId: maintenanceRunId, enabledIds: z.array(z.string().min(1).max(64)).max(20) }).strict().nullable(),
  lastRestore: receipt.nullable(),
}).strict();

export type MaintenanceRecord = z.infer<typeof maintenanceRecord>;
