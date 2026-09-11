export async function bindWorkflowCandidateStep(
  subjectKey: string,
  ownerToken: string,
  workflowRunId: string,
  ticketKey: string | null = null,
  kind: import("../../adapters/run-registry/types.js").RunKind = "ticket",
): Promise<boolean> {
  "use step";
  const { createAdapters } = await import("../support/adapters.js");
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
  entry: import("../agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<void> {
  "use step";
  if (!("manualDispatchId" in entry) || !entry.manualDispatchId) return;
  const { acknowledgeConnectedManualDispatchStarted } = await import(
    "../../db/repositories/manual-dispatch.js"
  );
  const acknowledged = await acknowledgeConnectedManualDispatchStarted(
    entry.manualDispatchId,
    entry.ownerToken,
    workflowRunId,
  );
  if (!acknowledged) {
    throw new Error(`Manual dispatch ${entry.manualDispatchId} could not be acknowledged`);
  }
}
acknowledgeManualDispatchStep.maxRetries = 0;

/** The dashboard starts the run before it can persist the returned run id. The
 * winning Workflow candidate records the same correlation after owner bind so
 * a lost route response/write cannot make a later approval retry start twice. */
export async function acknowledgeApprovalDispatchStep(
  entry: import("../agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<void> {
  "use step";
  if (entry.kind !== "plan_approved") return;
  const { setConnectedDispatchedRunId } = await import(
    "../../db/repositories/approvals.js"
  );
  await setConnectedDispatchedRunId(entry.approval.approvalRequestId, workflowRunId);
}

/** Close the dispatcher crash window from inside the winning workflow. The
 * delivery result and exact pending-snapshot deletion commit atomically. */
export async function acknowledgePrTriggerDispatchStep(
  entry: import("../agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  if (entry.kind !== "pr_trigger" || !entry.delivery) return true;
  const {
    acknowledgeConnectedStartedTriggerDelivery,
    completeConnectedTriggerDelivery,
  } = await import(
    "../../db/repositories/trigger-deliveries.js"
  );
  const {
    bindCurrentPullRequest,
    readProviderCurrentPullRequest,
  } = await import("../support/trigger-current-pull-request.js");
  const triggerEvent = {
    delivery: entry.delivery,
    triggerType: entry.triggerType,
    pr: entry.pr,
  };
  const current = await readProviderCurrentPullRequest(triggerEvent);
  if (!bindCurrentPullRequest(triggerEvent, current)) {
    await completeConnectedTriggerDelivery(
      entry.delivery.provider,
      entry.delivery.deliveryId,
      { result: "ignored_stale_head" },
    );
    return false;
  }
  return acknowledgeConnectedStartedTriggerDelivery({
    provider: entry.delivery.provider,
    deliveryId: entry.delivery.deliveryId,
    subjectKey: entry.subjectKey,
    runId: workflowRunId,
  });
}
acknowledgePrTriggerDispatchStep.maxRetries = 0;

/** Close the dispatcher crash window from inside the winning workflow. The
 * dispatcher publishes the same started envelope once start() returns; if it
 * dies in between, this step publishes it instead, so a live run is never left
 * with a pending row that the drain would start a second time. The store keeps
 * first start wins, which makes the two writers idempotent for this run and
 * exclusive against any other one. False means this run no longer owns the
 * delivery: another run recorded it first, or recovery rebound the subject
 * under a new owner token. Both cases bail safely. */
export async function acknowledgeWebhookDispatchStep(
  entry: import("../agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  if (entry.kind !== "webhook_trigger") return true;
  const { recordConnectedStartedWebhookTriggerDelivery } = await import(
    "../../db/repositories/webhook-trigger-deliveries.js"
  );
  return recordConnectedStartedWebhookTriggerDelivery({
    endpointId: entry.endpointId,
    deliveryId: entry.deliveryId,
    subjectKey: entry.subjectKey,
    ownerToken: entry.ownerToken,
    runId: workflowRunId,
  });
}
acknowledgeWebhookDispatchStep.maxRetries = 0;

/** Close the dispatcher crash window from inside the winning workflow, exactly as
 * the webhook step above does. Without it, a poll invocation killed between
 * start() and the dispatcher's publication leaves the occurrence pending, and the
 * next drain starts a SECOND run for the same instant. The store keeps first start
 * wins, so the two writers are idempotent for this run and exclusive against any
 * other. False means the occurrence was settled while the run was starting (a
 * pause is the realistic case): the run exists but no longer owns an occurrence,
 * so it bails and the shared orphaned-start path cleans it up. */
export async function acknowledgeScheduleDispatchStep(
  entry: import("../agent-input.js").AgentWorkflowInput,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  if (entry.kind !== "schedule") return true;
  const { recordConnectedStartedScheduleOccurrence } = await import(
    "../../db/repositories/schedule-triggers.js"
  );
  return recordConnectedStartedScheduleOccurrence({
    scheduleId: entry.scheduleId,
    occurrenceAt: new Date(entry.scheduledFor),
    ownerToken: entry.ownerToken,
    runId: workflowRunId,
  });
}
acknowledgeScheduleDispatchStep.maxRetries = 0;

export async function acknowledgePendingTriggerStep(
  entry: import("../agent-input.js").AgentWorkflowInput,
): Promise<void> {
  "use step";
  if ("continuation" in entry && entry.continuation?.kind === "clarification") return;
  if (entry.kind !== "pr_trigger" || !entry.pendingEvent || entry.delivery) return;
  const { deleteConnectedPendingTriggerDelivery } = await import(
    "../../db/repositories/trigger-deliveries.js"
  );
  await deleteConnectedPendingTriggerDelivery({
    provider: entry.pr.provider,
    deliveryId: entry.pendingEvent.deliveryId,
    subjectKey: entry.subjectKey,
  });
}
acknowledgePendingTriggerStep.maxRetries = 0;

/** Remove the clarification label only from the bound continuation. This step
 * deliberately does no pending-row or telemetry housekeeping: replaying it
 * cannot supersede a newer question. */
export async function repairClarificationLabelStep(
  ticketKey: string,
  owner: import("../../db/repositories/active-runs.js").ActiveRunOwner,
): Promise<void> {
  "use step";
  const { createAdapters } = await import("../../engine/support/adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../../engine/support/ticket-labels.js");
  const { updateConnectedTicketLabelsForRun } = await import(
    "../../engine/support/ticket-label-mutation.js"
  );
  const { issueTracker } = createAdapters();
  if (typeof issueTracker.updateLabels !== "function") return;
  await updateConnectedTicketLabelsForRun({
    issueTracker,
    ticketKey,
    owner,
    requiredOwnerState: "bound",
    changes: { remove: [NEEDS_CLARIFICATION_LABEL] },
  });
}
// Intentionally keep Workflow's default retries: removing a label is idempotent.
