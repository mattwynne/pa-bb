import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const work = z.object({ thread: z.string(), title: z.string(), plugins: z.array(z.string()) });

export const rpcContract = defineRpcContract({
  listWork: {
    input: z.object({}).strict(),
    output: z.object({
      active: z.array(work),
      queue: z.array(work.extend({ ready: z.boolean() })),
      completed: z.array(work.extend({ recorded: z.boolean() })),
      completedPartial: z.boolean(),
    }),
  },
});
