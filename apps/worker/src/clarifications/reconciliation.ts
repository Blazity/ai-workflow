import { getRun, start } from "workflow/api";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../adapters/issue-tracker/types.js";
import type { MessagingAdapter } from "../adapters/messaging/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { ticketRunUrl } from "../lib/dashboard-links.js";
import { NEEDS_CLARIFICATION_LABEL } from "../lib/labels.js";
import { logger } from "../lib/logger.js";
import { updateTicketLabelsWithIntent } from "../lib/ticket-label-mutation.js";
import { confirmWorkflowStepsDrained } from "../lib/workflow-step-drain.js";
import {
  moveTicketWithParkedOwnerIntent,
  reconcileUnfinishedTicketTransitions,
} from "../lib/ticket-transition.js";
import { stopSandboxesByIds } from "../sandbox/stop-ticket-sandboxes.js";
import { clarificationSnapshotCleanupWorkflow } from "../workflows/clarification-snapshot-cleanup.js";
import { dispatchClarificationAnswered } from "./dispatch.js";
import {
  listClarificationSnapshotCleanup,
  listClarificationParkingCandidates,
  listClarificationProviderParkingCandidates,
  listUndispatchedAnsweredClarifications,
  claimClarificationProviderParking,
  completeClarificationProviderParking,
  markClarificationSnapshotCleanupFailed,
  publishClarificationCheckpoint,
} from "./store.js";

const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Repairs the narrow interruption window after a checkpoint is published but
 * before its Workflow reaches the durable parking step. A bound owner is safe
 * to advance only after Workflow reports it terminal; an owner already in
 * `parking` has closed sandbox registration and can be drained immediately.
 */
export async function recoverInterruptedClarificationParking(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
}): Promise<number> {
  const candidates = await listClarificationParkingCandidates(input.db);
  let recovered = 0;

  for (const candidate of candidates) {
    try {
      const active = await input.runRegistry.get(candidate.subjectKey);
      if (
        active?.ownerToken !== candidate.ownerToken ||
        active.runId !== candidate.runId
      ) {
        continue;
      }
      if (active.state === "parked") continue;
      if (active.state === "bound") {
        const status = await getRun(candidate.runId).status;
        if (!TERMINAL_WORKFLOW_STATUSES.has(status)) continue;
        if (!(await confirmWorkflowStepsDrained(
          candidate.subjectKey,
          candidate.runId,
        ))) {
          continue;
        }
      } else if (active.state !== "parking") {
        continue;
      }

      const began = await input.runRegistry.beginParking(
        candidate.subjectKey,
        candidate.ownerToken,
        candidate.runId,
      );
      if (!began) {
        const current = await input.runRegistry.get(candidate.subjectKey);
        if (
          current?.ownerToken === candidate.ownerToken &&
          current.runId === candidate.runId &&
          current.state === "parked"
        ) {
          recovered++;
        }
        continue;
      }
      const sandboxIds = await input.runRegistry.listSandboxes(
        candidate.subjectKey,
        candidate.ownerToken,
      );
      await stopSandboxesByIds(sandboxIds);
      if (
        await input.runRegistry.finishParking(
          candidate.subjectKey,
          candidate.ownerToken,
          candidate.runId,
        )
      ) {
        recovered++;
      }
    } catch (error) {
      logger.warn(
        {
          clarificationId: candidate.clarificationId,
          subjectKey: candidate.subjectKey,
          runId: candidate.runId,
          error: error instanceof Error ? error.message : String(error),
        },
        "clarification_parking_recovery_failed",
      );
    }
  }

  return recovered;
}

/** Finishes the unanswerable Jira parking phase only after the exact asking
 * run is durably parked. Ambiguous provider calls retain both the checkpoint
 * and owner; once settled, the intended move is re-driven under a narrow
 * parked-owner CAS before publication makes the question answerable. */
export async function recoverClarificationProviderParking(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  messaging: MessagingAdapter;
  dashboardOrigin: string;
  target: IssueTrackerMoveTarget;
}): Promise<number> {
  const candidates = await listClarificationProviderParkingCandidates(input.db);
  let recovered = 0;

  for (const candidate of candidates) {
    try {
      const active = await input.runRegistry.get(candidate.subjectKey);
      if (
        active?.ownerToken !== candidate.ownerToken ||
        active.runId !== candidate.runId ||
        active.state !== "parked"
      ) {
        continue;
      }
      if (!(await claimClarificationProviderParking(
        input.db,
        candidate.clarificationId,
      ))) {
        continue;
      }

      const owner = {
        subjectKey: candidate.subjectKey,
        ownerToken: candidate.ownerToken,
        runId: candidate.runId,
      };
      const settlement = await reconcileUnfinishedTicketTransitions({
        db: input.db,
        issueTracker: input.issueTracker,
        ticketKey: candidate.ticketKey,
        owner,
      });
      if (!settlement.settled) continue;

      if (typeof input.issueTracker.updateLabels === "function") {
        await updateTicketLabelsWithIntent({
          db: input.db,
          issueTracker: input.issueTracker,
          ticketKey: candidate.ticketKey,
          owner,
          requiredOwnerState: "parked",
          changes: { add: [NEEDS_CLARIFICATION_LABEL] },
        });
      }

      await moveTicketWithParkedOwnerIntent({
        db: input.db,
        issueTracker: input.issueTracker,
        ticketKey: candidate.ticketKey,
        target: input.target,
        owner,
      });
      await completeClarificationProviderParking(
        input.db,
        candidate.clarificationId,
      );
      const publication = await publishClarificationCheckpoint(
        input.db,
        candidate.clarificationId,
      );
      if (!publication.publishedNow) continue;
      const currentOwner = await input.runRegistry.get(candidate.subjectKey);
      const mayNotify =
        currentOwner?.ownerToken === candidate.ownerToken &&
        currentOwner.runId === candidate.runId &&
        currentOwner.state === "parked";
      // The Jira label above is the durable user-visible state. Messaging is
      // intentionally best effort and belongs only to the durable publication
      // CAS winner. Re-read the exact owner immediately before transport so a
      // cancellation that closed parking after publication suppresses the
      // notification. This guard cannot make the subsequent Slack send
      // transactional with cancellation.
      if (mayNotify) {
        try {
          await input.messaging.notifyForTicket(candidate.ticketKey, {
            kind: "needs_clarification",
            dashboardUrl: ticketRunUrl(
              input.dashboardOrigin,
              candidate.ticketKey,
              candidate.runId,
            ),
          });
        } catch (error) {
          logger.warn(
            {
              clarificationId: candidate.clarificationId,
              ticketKey: candidate.ticketKey,
              error: error instanceof Error ? error.message : String(error),
            },
            "clarification_provider_parking_notification_failed",
          );
        }
      }
      recovered++;
    } catch (error) {
      logger.warn(
        {
          clarificationId: candidate.clarificationId,
          subjectKey: candidate.subjectKey,
          runId: candidate.runId,
          error: error instanceof Error ? error.message : String(error),
        },
        "clarification_provider_parking_recovery_failed",
      );
    }
  }

  return recovered;
}

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
