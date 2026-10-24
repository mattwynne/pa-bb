import { z } from 'zod';
import { applicationStatusSchema, applyInputSchema } from './core/application-model.ts';
export const rpcContract = {
  status: { input: z.null(), output: applicationStatusSchema },
  check: { input: z.null(), output: applicationStatusSchema },
  applicationStatus: { input: z.null(), output: applicationStatusSchema },
  review: { input: z.null(), output: applicationStatusSchema },
  resumeSync: { input: z.null(), output: applicationStatusSchema },
  apply: { input: applyInputSchema, output: applicationStatusSchema },
  applyLocal: { input: z.object({ reviewId: z.string().uuid() }).strict(), output: applicationStatusSchema },
};
