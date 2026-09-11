import { start } from "workflow/api";
import { env } from "../../infra/vcs-config.js";
import type { Db } from "../../db/types.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { AgentWorkflowInput } from "../../engine/index.js";
import { agentWorkflow } from "../../engine/index.js";
import { getConnectedWorkflowDefinition } from "../../db/repositories/definitions/connected.js";
import {
  getWorkflowDefinition,
} from "../../db/repositories/definitions.js";
import { aiColumnMoveTarget } from "../tickets/index.js";
import { AWAITING_APPROVAL_LABEL } from "../../engine/support/ticket-labels.js";
import { logger } from "../../infra/logger.js";
import { isActiveRunOwnerError } from "../../engine/support/run-control-errors.js";
import { ticketSubjectKey } from "../../engine/support/subject-key.js";
import { claimTicketRun } from "../dispatch/index.js";
import { updateTicketLabelsForRun, moveTicketForRun } from "../tickets/index.js";
import type { ApprovalRow } from "../../db/repositories/approvals.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersion,
  readDeployedWorkflowDefinitionVersion,
  readWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";

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
  db?: Db;
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
  const definition = db
    ? await getWorkflowDefinition(db, approval.definitionId)
    : await getConnectedWorkflowDefinition(approval.definitionId);
  if (!definition) {
    logger.info({ ticketKey, definitionId: approval.definitionId }, "plan_approved_definition_gone");
    return { status: "definition_gone" };
  }
  const pinned =
    approval.definitionVersion != null
      ? db
        ? await readWorkflowDefinitionVersion(db, approval.definitionId, approval.definitionVersion)
        : await readConnectedWorkflowDefinitionVersion(approval.definitionId, approval.definitionVersion)
      : db
        ? await readDeployedWorkflowDefinitionVersion(db, approval.definitionId)
        : await readConnectedDeployedWorkflowDefinitionVersion(approval.definitionId);
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

        const moveInput = {
          issueTracker,
          ticketKey,
          target: aiColumnMoveTarget(env),
          owner: { subjectKey, ownerToken, runId: null },
        };
        if (db) await moveTicketForRun({ ...moveInput, db });
        else {
          const { moveConnectedTicketForRun } = await import("../tickets/ticket-transition.js");
          await moveConnectedTicketForRun(moveInput);
        }

        if (typeof issueTracker.updateLabels === "function") {
          try {
            const labelInput = {
              issueTracker,
              ticketKey,
              owner: { subjectKey, ownerToken, runId: null },
              requiredOwnerState: "reserved" as const,
              changes: { remove: [AWAITING_APPROVAL_LABEL] },
            };
            if (db) await updateTicketLabelsForRun({ ...labelInput, db });
            else {
              const { updateConnectedTicketLabelsForRun } = await import("../tickets/ticket-label-mutation.js");
              await updateConnectedTicketLabelsForRun(labelInput);
            }
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
