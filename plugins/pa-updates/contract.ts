import { z } from 'zod';
import { statusSchema } from './core/model.ts';
export const rpcContract = {
  status: { input: z.null(), output: statusSchema },
  check: { input: z.null(), output: statusSchema },
};
