export async function bindWorkflowCandidateStep(
  subjectKey: string,
  ownerToken: string,
  workflowRunId: string,
  ticketKey: string | null = null,
  kind: import("../adapters/run-registry/types.js").RunKind = "ticket",
): Promise<boolean> {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  return createAdapters().runRegistry.markRunEntryStarted({
    subjectKey,
    ticketKey,
    kind,
    ownerToken,
    runId: workflowRunId,
  });
}
bindWorkflowCandidateStep.maxRetries = 0;

/** Close the manual-dispatch start ambiguity from inside the winning workflow.
 * The request is acknowledged only after the candidate owns the reserved
 * subject, so duplicate workflow candidates cannot both publish success. */
export async function acknowledgeManualDispatchStep(
  entry: import("./agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<void> {
  "use step";
  if (!("manualDispatchId" in entry) || !entry.manualDispatchId) return;
  const { getDb } = await import("../db/client.js");
  const { acknowledgeManualDispatchWorkflow } = await import(
    "../manual-dispatch/service.js"
  );
  const acknowledged = await acknowledgeManualDispatchWorkflow(getDb(), {
    requestId: entry.manualDispatchId,
    ownerToken: entry.ownerToken,
    runId: workflowRunId,
  });
  if (!acknowledged) {
    throw new Error(`Manual dispatch ${entry.manualDispatchId} could not be acknowledged`);
  }
}
acknowledgeManualDispatchStep.maxRetries = 0;

/** The dashboard starts the run before it can persist the returned run id. The
 * winning Workflow candidate records the same correlation after owner bind so
 * a lost route response/write cannot make a later approval retry start twice. */
export async function acknowledgeApprovalDispatchStep(
  entry: import("./agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<void> {
  "use step";
  if (entry.kind !== "plan_approved") return;
  const { getDb } = await import("../db/client.js");
  const { setDispatchedRunId } = await import("../approvals/store.js");
  await setDispatchedRunId(getDb(), entry.approval.approvalRequestId, workflowRunId);
}

/** Close the dispatcher crash window from inside the winning workflow. The
 * delivery result and exact pending-snapshot deletion commit atomically. */
export async function acknowledgePrTriggerDispatchStep(
  entry: import("./agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  if (entry.kind !== "pr_trigger" || !entry.delivery) return true;
  const { getDb } = await import("../db/client.js");
  const db = getDb();
  const {
    acknowledgeStartedTriggerDelivery,
    completeTriggerDelivery,
  } = await import(
    "../lib/trigger-delivery-store.js"
  );
  const {
    bindCurrentPullRequest,
    readProviderCurrentPullRequest,
  } = await import("../lib/trigger-current-pull-request.js");
  const triggerEvent = {
    delivery: entry.delivery,
    triggerType: entry.triggerType,
    pr: entry.pr,
  };
  const current = await readProviderCurrentPullRequest(triggerEvent);
  if (!bindCurrentPullRequest(triggerEvent, current)) {
    await completeTriggerDelivery(
      db,
      entry.delivery.provider,
      entry.delivery.deliveryId,
      { result: "ignored_stale_head" },
    );
    return false;
  }
  return acknowledgeStartedTriggerDelivery(
    db,
    {
      subjectKey: entry.subjectKey,
      triggerType: entry.triggerType,
      delivery: entry.delivery,
      pr: entry.pr,
      definitionId: entry.definitionId,
      definitionVersion: entry.definitionVersion,
    },
    workflowRunId,
  );
}
acknowledgePrTriggerDispatchStep.maxRetries = 0;

export async function acknowledgePendingTriggerStep(
  entry: import("./agent-input.js").AgentWorkflowInput,
): Promise<void> {
  "use step";
  if ("continuation" in entry && entry.continuation?.kind === "clarification") return;
  if (entry.kind !== "pr_trigger" || !entry.pendingEvent || entry.delivery) return;
  const { getDb } = await import("../db/client.js");
  const { deletePendingTrigger } = await import("../lib/trigger-delivery-store.js");
  await deletePendingTrigger(getDb(), {
    subjectKey: entry.subjectKey,
    triggerType: entry.pendingEvent.triggerType,
    delivery: {
      provider: entry.pr.provider,
      producer: "pending-snapshot",
      deliveryId: entry.pendingEvent.deliveryId,
    },
    pr: { ...entry.pr, headSha: entry.pendingEvent.headSha },
    definitionId: entry.definitionId,
    definitionVersion: entry.definitionVersion,
  });
}
acknowledgePendingTriggerStep.maxRetries = 0;

/** Remove the clarification label only from the bound continuation. This step
 * deliberately does no pending-row or telemetry housekeeping: replaying it
 * cannot supersede a newer question. */
export async function repairClarificationLabelStep(
  ticketKey: string,
  owner: import("../lib/active-run-owner.js").ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../lib/ticket-label-mutation.js"
  );
  const { issueTracker } = createAdapters();
  if (typeof issueTracker.updateLabels !== "function") return;
  await updateTicketLabelsForRun({
    db: getDb(),
    issueTracker,
    ticketKey,
    owner,
    requiredOwnerState: "bound",
    changes: { remove: [NEEDS_CLARIFICATION_LABEL] },
  });
}
// Intentionally keep Workflow's default retries: removing a label is idempotent.
