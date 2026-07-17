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
  const { runRegistry } = createStepAdapters();
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
  if (entry.kind !== "pr_trigger" || !entry.pendingEvent) return;
  const { getDb } = await import("../db/client.js");
  const { deletePendingTrigger } = await import("../lib/trigger-delivery-store.js");
  await deletePendingTrigger(getDb(), {
    subjectKey: entry.subjectKey,
    triggerType: entry.pendingEvent.triggerType,
    pr: { ...entry.pr, headSha: entry.pendingEvent.headSha },
  });
}
acknowledgePendingTriggerStep.maxRetries = 0;
