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

export async function recordClarificationDispatchWinnerStep(
  clarificationId: string,
  ownerToken: string,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getClarification, recordDispatchedRun } = await import(
    "../clarifications/store.js"
  );
  const db = getDb();
  const recorded = await recordDispatchedRun(
    db,
    clarificationId,
    ownerToken,
    workflowRunId,
  );
  if (!recorded) return false;
  const checkpoint = await getClarification(db, clarificationId);
  if (!checkpoint || checkpoint.dispatchedRunId !== workflowRunId) {
    throw new Error(`clarification ${clarificationId} lost its bound dispatch winner`);
  }
  const { resolveAwaitingRun } = await import(
    "../lib/telemetry/run-telemetry.js"
  );
  await resolveAwaitingRun(db, checkpoint.runId).catch(() => false);
  return true;
}

export async function consumeClarificationCheckpointStep(
  clarificationId: string,
  ownerToken: string,
  workflowRunId: string,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markClarificationCheckpointConsumed } = await import(
    "../clarifications/store.js"
  );
  const consumed = await markClarificationCheckpointConsumed(
    getDb(),
    clarificationId,
    ownerToken,
    workflowRunId,
  );
  if (!consumed) {
    throw new Error(
      `clarification ${clarificationId} could not cross its bound replay boundary`,
    );
  }
}

export async function clearClarificationDispatchWinnerStep(
  clarificationId: string,
  ownerToken: string,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { clearDispatchedRun } = await import("../clarifications/store.js");
  return clearDispatchedRun(getDb(), clarificationId, ownerToken, workflowRunId);
}

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
): Promise<void> {
  "use step";
  if (entry.kind !== "pr_trigger" || !entry.delivery) return;
  const { getDb } = await import("../db/client.js");
  const { acknowledgeStartedTriggerDelivery } = await import(
    "../lib/trigger-delivery-store.js"
  );
  await acknowledgeStartedTriggerDelivery(
    getDb(),
    {
      subjectKey: entry.subjectKey,
      triggerType: entry.triggerType,
      delivery: entry.delivery,
      pr: entry.pr,
    },
    workflowRunId,
  );
}
acknowledgePrTriggerDispatchStep.maxRetries = 0;

export async function terminalReleaseAndDrainStep(
  subjectKey: string,
  ownerToken: string,
  workflowRunId: string,
): Promise<boolean> {
  "use step";
  const { env } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { drainOldestPendingTrigger } = await import("../lib/dispatch-trigger.js");
  const { stopSandboxesByIds } = await import("../sandbox/stop-ticket-sandboxes.js");
  const { runRegistry } = createStepAdapters();
  const sandboxIds = await runRegistry.listSandboxes(subjectKey, ownerToken).catch(() => null);
  if (sandboxIds === null) return false;
  try {
    await stopSandboxesByIds(sandboxIds);
  } catch {
    return false;
  }
  const released = await runRegistry.release(subjectKey, ownerToken, workflowRunId);
  if (!released) return false;
  await drainOldestPendingTrigger(subjectKey, {
    db: getDb(),
    runRegistry,
    maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
  });
  return true;
}
terminalReleaseAndDrainStep.maxRetries = 0;

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
  });
}
acknowledgePendingTriggerStep.maxRetries = 0;
