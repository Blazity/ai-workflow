import { z } from "zod";
import type { BlockExecuteFn } from "./types.js";

export const paramsSchema = z
  .object({
    taskName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * arthur_trace: declarative marker with no runtime behavior of its own. The
 * taskName param is consumed by prepare_workspace through
 * ctx.arthur.taskNameOverride: stage C4's engine pre-scans the definition for
 * an arthur_trace block and copies its taskName into the ctx before any block
 * runs, so the run's Arthur task is ensured under that name regardless of
 * where this block sits in the graph. Executing the block is a no-op.
 */
export const execute: BlockExecuteFn = async () => {
  return { kind: "next", output: { status: "ok" } };
};
