import { start } from "workflow/api";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { clarificationSnapshotCleanupWorkflow } from "../workflows/clarification-snapshot-cleanup.js";
import { dispatchClarificationAnswered } from "./dispatch.js";
import {
  listClarificationSnapshotCleanup,
  listUndispatchedAnsweredClarifications,
  markClarificationSnapshotCleanupFailed,
} from "./store.js";

export async function recoverUndispatchedClarificationSuccessors(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  maxConcurrentAgents: number;
}): Promise<number> {
  const checkpoints = await listUndispatchedAnsweredClarifications(input.db);
  let recovered = 0;

  for (const checkpoint of checkpoints) {
    try {
      const result = await dispatchClarificationAnswered({
        ...input,
        clarification: checkpoint,
        answer: checkpoint.answer!,
        actor: {
          id: checkpoint.answeredById ?? "reconciliation",
          label: checkpoint.answeredByLabel ?? "Clarification reconciliation",
        },
        isRetry: true,
      });
      if (result.status !== "started") continue;

      recovered++;
    } catch (error) {
      logger.warn(
        {
          clarificationId: checkpoint.id,
          ticketKey: checkpoint.ticketKey,
          error: (error as Error).message,
        },
        "clarification_reconciliation_successor_failed",
      );
    }
  }

  return recovered;
}

export async function startQueuedClarificationSnapshotCleanups(input: {
  db: Db;
}): Promise<number> {
  const candidates = await listClarificationSnapshotCleanup(input.db);
  let started = 0;

  for (const candidate of candidates) {
    try {
      await start(clarificationSnapshotCleanupWorkflow, [candidate]);
      started++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markClarificationSnapshotCleanupFailed(
        input.db,
        candidate.clarificationId,
        message,
      ).catch(() => {});
      logger.warn(
        { ...candidate, error: message },
        "clarification_snapshot_cleanup_start_failed",
      );
    }
  }

  return started;
}
