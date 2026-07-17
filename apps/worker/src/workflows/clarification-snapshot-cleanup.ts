import {
  claimClarificationSnapshotCleanupStep,
  markClarificationSnapshotCleanupFailedStep,
  markClarificationSnapshotDeletedStep,
} from "./clarification-checkpoint-steps.js";
import { deleteClarificationSnapshotStep } from "./clarification-snapshot-steps.js";

export interface ClarificationSnapshotCleanupInput {
  clarificationId: string;
  snapshotId: string;
}

/** Durable cleanup runner; its first step CAS-claims the queued DB row. */
export async function clarificationSnapshotCleanupWorkflow(
  input: ClarificationSnapshotCleanupInput,
): Promise<void> {
  "use workflow";

  const claimed = await claimClarificationSnapshotCleanupStep(
    input.clarificationId,
  );
  if (!claimed) return;

  try {
    await deleteClarificationSnapshotStep(input.snapshotId);
    await markClarificationSnapshotDeletedStep(input.clarificationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markClarificationSnapshotCleanupFailedStep(
      input.clarificationId,
      message,
    );
    throw error;
  }
}
