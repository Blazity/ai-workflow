import { start } from "workflow/api";
import { env } from "../../env.js";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { claimTicketRun } from "../lib/dispatch.js";
import { aiColumnMoveTarget } from "../lib/move-targets.js";
import { NEEDS_CLARIFICATION_LABEL } from "../lib/labels.js";
import { logger } from "../lib/logger.js";
import {
  answerClarification,
  getClarification,
  ClarificationStoreError,
  type ClarificationRow,
} from "./store.js";

export type DispatchClarificationAnsweredResult =
  | { status: "at_capacity" }
  | { status: "already_claimed" }
  | { status: "conflict" }
  | { status: "started"; runId: string };

/**
 * Resumes a run parked on a clarification once a human answers it. Mirrors the
 * plan-approval dispatch: reuses the shared claimTicketRun claim/capacity/verify
 * dance (kind "ticket", so reconcile treats the resume run like any other) and
 * performs the answer CAS + the required ticket move under the claim.
 *
 * Ordering under the claim is load-bearing: CAS (record the answer) -> move the
 * ticket into the AI column -> best-effort remove the needs-clarification label
 * -> start the resume run -> register. The caller records the dispatched run id
 * and resolves the parked run after a started result.
 */
export async function dispatchClarificationAnswered(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  clarification: ClarificationRow;
  answer: string;
  actor: { id: string; label: string };
  maxConcurrentAgents: number;
  isRetry: boolean;
}): Promise<DispatchClarificationAnsweredResult> {
  const {
    db,
    runRegistry,
    issueTracker,
    clarification,
    answer,
    actor,
    maxConcurrentAgents,
    isRetry,
  } = input;
  const ticketKey = clarification.ticketKey;

  // Stashed across the postClaimGuard boundary: claimTicketRun collapses any
  // throw from the guard to reason "error" and loses the status. A lost CAS
  // (409) is caught, stashed, and rethrown after claimTicketRun returns so the
  // route can map its statusCode; a retry that lost the re-verify surfaces as a
  // conflict result the same way.
  let casError: ClarificationStoreError | null = null;
  let conflictOnRetry = false;

  const result = await claimTicketRun(ticketKey, runRegistry, maxConcurrentAgents, {
    kind: "ticket",
    postClaimGuard: async () => {
      if (!isRetry) {
        // Record the answer under the claim (CAS pending -> answered). A
        // concurrent manual re-pickup fails the claim before we get here; a
        // concurrent answerer loses this CAS. Throwing here directly would
        // collapse to reason "error" and lose the 409, so stash and bail.
        try {
          await answerClarification(db, { id: clarification.id, answer, actor });
        } catch (err) {
          if (err instanceof ClarificationStoreError) {
            casError = err;
            return { started: false };
          }
          throw err;
        }
      } else {
        // Retry after a dispatch that failed post-CAS: the answer already
        // stands, so re-verify the row is still answered-without-a-run under
        // the claim instead of re-running the CAS. A concurrently dispatched
        // run means we bail as a conflict.
        const fresh = await getClarification(db, clarification.id);
        if (!fresh || fresh.status !== "answered" || fresh.dispatchedRunId !== null) {
          conflictOnRetry = true;
          return { started: false };
        }
      }

      // Move the ticket INTO the AI column before starting the resume run:
      // reconcile cancels a registered ticket run whose ticket is not in the AI
      // column (the ticket is parked in the backlog), so the run must never
      // start with the ticket still parked. A move failure propagates: the
      // claim is released, the row stays answered with a null dispatchedRunId
      // (which the endpoint treats as retryable), and no run is started; a cron
      // poll also re-picks the ticket as a plain run if the move actually landed.
      await issueTracker.moveTicket(ticketKey, aiColumnMoveTarget(env));

      // Best-effort label removal AFTER the move: removing it while the ticket
      // is still in the backlog fires a label-change webhook that would see the
      // backlog status and cancel our own claim.
      if (typeof issueTracker.updateLabels === "function") {
        try {
          await issueTracker.updateLabels(ticketKey, {
            remove: [NEEDS_CLARIFICATION_LABEL],
          });
        } catch (err) {
          logger.warn(
            { ticketKey, error: (err as Error).message },
            "clarification_answered_label_remove_failed",
          );
        }
      }

      return null;
    },
    startWorkflow: async () => {
      // Leave definitionId unset: the resume loads the head definition for the
      // clarification_answered trigger.
      const entry: AgentWorkflowInput = {
        kind: "clarification_answered",
        ticketKey,
        clarificationRequestId: clarification.id,
      };
      const handle = await start(agentWorkflow, [entry]);
      logger.info({ ticketKey, runId: handle.runId }, "clarification_answered_workflow_started");
      return handle.runId;
    },
  });

  if (casError) throw casError;
  if (conflictOnRetry) return { status: "conflict" };

  if (result.started) {
    return { status: "started", runId: result.runId! };
  }
  if (result.reason === "at_capacity") {
    return { status: "at_capacity" };
  }
  if (result.reason === "already_claimed") {
    return { status: "already_claimed" };
  }
  // reason "error" (e.g. the move threw and claimTicketRun swept it): surface as
  // a thrown failure the route reports as retryable, mirroring approvals' 500 on
  // a dispatch that failed after the decision.
  throw new Error(`clarification_dispatch_failed:${result.reason ?? "unknown"}`);
}
