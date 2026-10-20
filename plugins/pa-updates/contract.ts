import { z } from 'zod';
import { statusSchema } from './core/model.ts';
import { applicationStatusSchema, applyInputSchema } from './core/application-model.ts';
export const rpcContract = {
  status: { input: z.null(), output: statusSchema },
  check: { input: z.null(), output: statusSchema },
  applicationStatus: { input: z.null(), output: applicationStatusSchema },
  review: { input: z.null(), output: applicationStatusSchema },
  resumeSync: { input: z.null(), output: applicationStatusSchema },
  apply: { input: applyInputSchema, output: applicationStatusSchema },
};
