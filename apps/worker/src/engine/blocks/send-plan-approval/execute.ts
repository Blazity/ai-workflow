import type { IssueTrackerMoveTarget } from "../../../adapters/issue-tracker/types.js";
import type { ActiveRunOwner } from "../../../db/repositories/active-runs.js";
import type { TicketTransitionOwner } from "../../support/ticket-transition.js";
import { isRunControlError } from "../../helpers/run-control-error.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "../support/types.js";
import type { ApprovedRepositoryScope } from "@shared/contracts";
import type { WorkspaceManifest } from "../../../sandbox/repo-workspace.js";
import type { ResearchRepository } from "../../../sandbox/agents/types.js";

async function createApprovalRequestStep(input: {
  ticketKey: string;
  definitionId: number;
  definitionVersion: number | null;
  runId: string;
  plan: { markdown: string };
  assumptions: string[] | null;
  repositoryScope: ApprovedRepositoryScope | null;
}): Promise<string> {
  "use step";
  const { createConnectedApprovalRequest } = await import("../../../db/repositories/approvals.js");
  const row = await createConnectedApprovalRequest(input);
  return row.id;
}
createApprovalRequestStep.maxRetries = 1;

export function approvedRepositoryScopeFromManifest(
  manifest: WorkspaceManifest | null,
  writeRepositories: readonly ResearchRepository[] = [],
): ApprovedRepositoryScope | null {
  if (manifest?.version !== 2) return null;
  // In an approval-gated graph the planning run deliberately does not promote the
  // write scope (that would create a remote branch and ledger row before approval),
  // so the manifest is still all-read. The research write set carries which repos
  // the plan intends to change; overlay it here so the approved implementation run
  // promotes exactly those repos, exactly as it did when planning promoted eagerly.
  const writeKeys = new Set(
    writeRepositories.map(
      (repository) => `${repository.provider}:${repository.repoPath.toLowerCase()}`,
    ),
  );
  return {
    repositories: manifest.repositories.map((repository) => {
      if (!repository.researchBaseSha) {
        throw new Error(
          `Repository ${repository.provider}:${repository.repoPath} is missing its trusted research baseline`,
        );
      }
      const key = `${repository.provider}:${repository.repoPath.toLowerCase()}`;
      const access =
        repository.access === "write" || writeKeys.has(key) ? "write" : "read";
      return {
        provider: repository.provider,
        repoPath: repository.repoPath,
        defaultBranch: repository.defaultBranch,
        researchBranch: repository.branchName,
        researchBaseSha: repository.researchBaseSha,
        access,
        rationale: repository.selectedRationale,
      };
    }),
  };
}

async function mirrorApprovalCommentStep(
  ticketId: string,
  body: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { assertConnectedActiveRunOwner } = await import("../../../db/repositories/active-runs.js");
  const { createAdapters } = await import("../../../engine/support/adapters.js");
  const { issueTracker } = createAdapters();
  await assertConnectedActiveRunOwner(owner);
  await issueTracker.postComment(ticketId, body);
}
mirrorApprovalCommentStep.maxRetries = 0;

async function notifyPlanApprovalStep(
  ticketKey: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { assertConnectedActiveRunOwner } = await import("../../../db/repositories/active-runs.js");
  const { createAdapters } = await import("../../../engine/support/adapters.js");
  const { messaging } = createAdapters();
  await assertConnectedActiveRunOwner(owner);
  await messaging.notifyForTicket(ticketKey, { kind: "plan_approval_requested" });
}
notifyPlanApprovalStep.maxRetries = 0;

async function parkForApprovalStep(
  ticketId: string,
  backlogTarget: IssueTrackerMoveTarget,
  owner: TicketTransitionOwner,
): Promise<void> {
  "use step";
  const { createAdapters } = await import("../../../engine/support/adapters.js");
  const { AWAITING_APPROVAL_LABEL } = await import("../../../engine/support/ticket-labels.js");
  const { updateConnectedTicketLabelsForRun } = await import(
    "../../../engine/support/ticket-label-mutation.js"
  );
  const { moveConnectedTicketForRun } = await import("../../../engine/support/ticket-transition.js");
  const { issueTracker } = createAdapters();
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await updateConnectedTicketLabelsForRun({
        issueTracker,
        ticketKey: ticketId,
        owner,
        requiredOwnerState: "bound",
        changes: { add: [AWAITING_APPROVAL_LABEL] },
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      const { logger } = await import("../../../infra/logger.js");
      logger.warn(
        { ticketId, err: err instanceof Error ? err.message : String(err) },
        "approval_label_add_failed",
      );
    }
  }
  // The approval row is already committed by the time we park, so a failed move must not
  // fail the block: the plan is filed and pending in the dashboard either way, and letting
  // this throw would report the whole run as failed while the operator sees a pending plan.
  // Log it, because an unparked ticket stays in the AI column and the cron poll can
  // re-dispatch it. Swallowing here rather than in the caller keeps pino inside the step:
  // workflow scope forbids Node modules.
  try {
    await moveConnectedTicketForRun({
      issueTracker,
      ticketKey: ticketId,
      target: backlogTarget,
      owner,
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../../infra/logger.js");
    logger.warn(
      { ticketId, err: err instanceof Error ? err.message : String(err) },
      "approval_park_failed",
    );
  }
}
parkForApprovalStep.maxRetries = 0;

/**
 * send_plan_approval: file the run's plan for human approval, then end the run.
 * The plan text comes from the block's resolved `plan` input. The run's
 * research plan remains a compatibility fallback for stored definitions that
 * predate typed inputs. After unregistering the
 * run it parks the ticket in the backlog column with an awaiting-approval
 * label, mirroring the clarification exit: moving the ticket out of the AI
 * column is what stops the cron poll from re-dispatching it while it waits. A
 * later dashboard approval starts a fresh trigger_plan_approved run, whose
 * dispatch skips the column check so the ticket's backlog location does not
 * block it.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs,
): Promise<BlockExecutionResult> => {
  const markdown =
    typeof resolvedInputs?.plan === "string"
      ? resolvedInputs.plan
      : ctx.researchPlanMarkdown;
  if (markdown.trim().length === 0) {
    return executionError("no plan available", { category: "binding" });
  }

  if (ctx.definitionId === null) {
    return executionError("approval requires a stored definition", {
      category: "binding",
    });
  }

  const rawAssumptions = resolvedInputs?.assumptions;
  const assumptions = Array.isArray(rawAssumptions)
    ? rawAssumptions.filter((a): a is string => typeof a === "string")
    : [];
  const owner: ActiveRunOwner = {
    subjectKey: ctx.entry.subjectKey,
    ownerToken: ctx.entry.ownerToken,
    runId: ctx.runId,
  };

  let approvalRequestId: string;
  try {
    const repositoryScope = approvedRepositoryScopeFromManifest(
      ctx.workspaceManifest,
      ctx.researchWriteRepositories,
    );
    approvalRequestId = await createApprovalRequestStep({
      ticketKey: ctx.ticket.identifier,
      definitionId: ctx.definitionId,
      // Pin the approval to the version that generated this plan. definitionId is
      // non-null here (guarded above), so a stored definition loaded and its
      // version is the concrete head at load time, never null.
      definitionVersion: ctx.definitionVersion,
      runId: ctx.runId,
      plan: { markdown },
      assumptions: assumptions.length > 0 ? assumptions : null,
      repositoryScope,
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }

  if (block.params.mirrorComment !== false) {
    await mirrorApprovalCommentStep(
      ctx.ticket.identifier,
      "Plan awaiting approval in the dashboard.",
      owner,
    ).catch((error) => {
      if (isRunControlError(error)) throw error;
    });
  }

  await notifyPlanApprovalStep(ctx.ticket.identifier, owner).catch((error) => {
    if (isRunControlError(error)) throw error;
  });

  await parkForApprovalStep(ctx.ticket.identifier, ctx.moveTargets.backlog, owner);

  return { kind: "ended", output: { status: "awaiting_approval", approvalRequestId } };
};
