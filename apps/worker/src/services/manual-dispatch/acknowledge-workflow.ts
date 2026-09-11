import type { Db } from "../../db/client.js";
import { acknowledgeManualDispatchStarted } from "../../db/repositories/manual-dispatch.js";

export async function acknowledgeManualDispatchWorkflow(
  db: Db,
  input: {
    requestId: string;
    ownerToken: string;
    runId: string;
  },
): Promise<boolean> {
  return acknowledgeManualDispatchStarted(
    db,
    input.requestId,
    input.ownerToken,
    input.runId,
  );
}
