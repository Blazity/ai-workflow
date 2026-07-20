export async function bindWorkflowCandidateStep(
  subjectKey: string,
  ownerToken: string,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  return createStepAdapters().runRegistry.bindRun(subjectKey, ownerToken, workflowRunId);
}
bindWorkflowCandidateStep.maxRetries = 0;

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

/**
 * Durable clarification exit barrier. `beginParking` closes child registration,
 * the sandbox helper terminal-confirms every exact durable child, and only then
 * may `finishParking` publish the handoff-eligible state. Telemetry is
 * intentionally absent from this proof.
 */
export async function parkClarificationOwnerStep(
  subjectKey: string,
  ownerToken: string,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { ActiveRunOwnerError } = await import("../lib/run-control-errors.js");
  const { stopSandboxesByIds } = await import("../sandbox/stop-ticket-sandboxes.js");
  const { isRunControlError } = await import("./run-control-error.js");
  const { runRegistry } = createStepAdapters();
  const isExactOwner = (current: Awaited<ReturnType<typeof runRegistry.get>>) =>
    current?.ownerToken === ownerToken && current.runId === workflowRunId;
  const ownerLost = (state: string | null) =>
    new ActiveRunOwnerError(
      `Clarification parking lost the exact active run owner (state: ${state ?? "missing"}).`,
    );
  try {
    const began = await runRegistry.beginParking(subjectKey, ownerToken, workflowRunId);
    if (!began) {
      const current = await runRegistry.get(subjectKey);
      if (isExactOwner(current) && current?.state === "parked") {
        return true;
      }
      throw ownerLost(current?.state ?? null);
    }
    const sandboxIds = await runRegistry.listSandboxes(subjectKey, ownerToken);
    await stopSandboxesByIds(sandboxIds);
    if (await runRegistry.finishParking(subjectKey, ownerToken, workflowRunId)) {
      return true;
    }
    // A concurrent reconciler may have drained and parked the same exact
    // owner. Either way, beginParking already closed child registration; keep
    // the asking run awaiting and let reconciliation own any remaining work.
    const current = await runRegistry.get(subjectKey);
    if (isExactOwner(current) && current?.state === "parked") {
      return true;
    }
    if (!isExactOwner(current) || current?.state === "cancelling") {
      throw ownerLost(current?.state ?? null);
    }
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { subjectKey, ownerToken, workflowRunId, state: current?.state ?? null },
      "clarification_parking_handed_to_reconciliation",
    );
  } catch (error) {
    if (isRunControlError(error)) throw error;
    // Ordinary infrastructure errors remain recoverable. If beginParking won,
    // the durable `parking` boundary prevents a generic terminal release; if
    // it did not complete, the exact bound claim remains for reconciliation to
    // retry. Structural cancellation/owner-loss signals were rethrown above.
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      {
        subjectKey,
        ownerToken,
        workflowRunId,
        error: error instanceof Error ? error.message : String(error),
      },
      "clarification_parking_deferred_to_reconciliation",
    );
  }
  return true;
}

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
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { updateTicketLabelsWithIntent } = await import(
    "../lib/ticket-label-mutation.js"
  );
  const { issueTracker } = createStepAdapters();
  if (typeof issueTracker.updateLabels !== "function") return;
  await updateTicketLabelsWithIntent({
    db: getDb(),
    issueTracker,
    ticketKey,
    owner,
    requiredOwnerState: "bound",
    changes: { remove: [NEEDS_CLARIFICATION_LABEL] },
  });
}
// Intentionally keep Workflow's default retries: removing a label is idempotent.
