import { start } from "workflow/api";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { AgentWorkflowInput } from "../../engine/index.js";
import { agentWorkflow } from "../../engine/index.js";
import {
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
} from "../../workflow-definition/store.js";
import { aiColumnMoveTarget } from "../tickets/move-targets.js";
import { AWAITING_APPROVAL_LABEL } from "../tickets/labels.js";
import { logger } from "../../infra/logger.js";
import { isActiveRunOwnerError } from "../run-lifecycle/run-control-errors.js";
import { claimTicketRun } from "../dispatch/dispatch.js";
import { ticketSubjectKey } from "../run-lifecycle/subject-key.js";
import { updateTicketLabelsForRun } from "../tickets/ticket-label-mutation.js";
import { moveTicketForRun } from "../tickets/ticket-transition.js";
import type { ApprovalRow } from "../../approvals/store.js";

export type DispatchPlanApprovedResult =
  | { status: "definition_gone" }
  | { status: "run_in_flight" }
  | { status: "started"; runId: string };

/**
 * Starts a trigger_plan_approved run for an approved plan. It uses the same
 * owner-CAS reservation and capacity path as direct ticket dispatch. The
 * dispatcher binds the returned runtime id before reporting success; workflow
 * entry repeats the exact bind as a crash-window fallback.
 *
 * The optional onClaimed gate runs once the ticket is reserved and before the
 * workflow starts; a caller passes the compare-and-set decision there so the
 * claim protects the decision (throwing releases the claim). Callers map the
 * three result statuses onto their own responses.
 */
export async function dispatchPlanApproved(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  approval: ApprovalRow;
  actor: { id: string; label: string };
  maxConcurrentAgents: number;
  onClaimed?: () => Promise<void>;
}): Promise<DispatchPlanApprovedResult> {
  const { db, runRegistry, issueTracker, approval, actor, maxConcurrentAgents, onClaimed } = input;
  const ticketKey = approval.ticketKey;
  const subjectKey = ticketSubjectKey("jira", ticketKey);

  // Resolve the exact definition version the approved plan pins. A human already
  // approved this plan, so it must run the graph they reviewed regardless of the
  // definition's current enabled flag: disabling a definition must not strand an
  // approved plan. Archiving only removes a definition from future selection;
  // it cannot revoke an already-approved immutable version. Only a genuinely
  // missing definition or version blocks the run and is surfaced as
  // definition_gone. Legacy
  // rows with a null pinned version fall back to the selected deployed version,
  // never an undeployed draft snapshot.
  const definition = await getWorkflowDefinition(db, approval.definitionId);
  if (!definition) {
    logger.info({ ticketKey, definitionId: approval.definitionId }, "plan_approved_definition_gone");
    return { status: "definition_gone" };
  }
  const pinned =
    approval.definitionVersion != null
      ? await getWorkflowDefinitionVersion(db, approval.definitionId, approval.definitionVersion)
      : await getDeployedWorkflowDefinitionVersion(db, approval.definitionId);
  if (!pinned) {
    logger.info(
      { ticketKey, definitionId: approval.definitionId, version: approval.definitionVersion },
      "plan_approved_definition_gone",
    );
    return { status: "definition_gone" };
  }

  let dispatchError: unknown;
  const result = await claimTicketRun(ticketKey, runRegistry, maxConcurrentAgents, {
    kind: "ticket",
    postClaimGuard: async (ownerToken) => {
      try {
        if (onClaimed) await onClaimed();

        await moveTicketForRun({
          db,
          issueTracker,
          ticketKey,
          target: aiColumnMoveTarget(env),
          owner: { subjectKey, ownerToken, runId: null },
        });

        if (typeof issueTracker.updateLabels === "function") {
          try {
            await updateTicketLabelsForRun({
              db,
              issueTracker,
              ticketKey,
              owner: { subjectKey, ownerToken, runId: null },
              requiredOwnerState: "reserved",
              changes: { remove: [AWAITING_APPROVAL_LABEL] },
            });
          } catch (err) {
            if (isActiveRunOwnerError(err)) throw err;
            logger.warn(
              { ticketKey, error: (err as Error).message },
              "plan_approved_label_remove_failed",
            );
          }
        }
        return null;
      } catch (err) {
        dispatchError = err;
        throw err;
      }
    },
    startWorkflow: async (ownerToken) => {
      try {
        const entry: AgentWorkflowInput = {
          kind: "plan_approved",
          subjectKey,
          ticketKey,
          ownerToken,
          definitionId: approval.definitionId,
          definitionVersion: pinned.version,
          approvedPlan: {
            markdown: approval.plan.markdown,
            sourceRunId: approval.runId,
            assumptions: approval.assumptions ?? undefined,
            repositoryScope: approval.repositoryScope ?? undefined,
          },
          approval: {
            approvalRequestId: approval.id,
            approver: actor.label,
            approvedAt: new Date().toISOString(),
          },
        };
        const handle = await start(agentWorkflow, [entry]);
        logger.info({ ticketKey, runId: handle.runId }, "plan_approved_workflow_started");
        return handle.runId;
      } catch (err) {
        dispatchError = err;
        throw err;
      }
    },
  });

  if (!result.started) {
    if (result.reason === "error" && dispatchError) throw dispatchError;
    return { status: "run_in_flight" };
  }
  return { status: "started", runId: result.runId! };
}
