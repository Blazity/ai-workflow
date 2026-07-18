import { beforeEach, describe, expect, it, vi } from "vitest";

const bindRun = vi.fn();
const release = vi.fn();
const drain = vi.fn();
const deletePending = vi.fn();
const recordDispatched = vi.fn();
const clearDispatched = vi.fn();
const getClarification = vi.fn();
const markConsumed = vi.fn();
const resolveAwaitingRun = vi.fn();
const acknowledgeStartedDelivery = vi.fn();
const setApprovalRun = vi.fn();
const listSandboxes = vi.fn();
const stopSandboxes = vi.fn();
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { bindRun, release, listSandboxes } }),
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../../env.js", () => ({ env: { MAX_CONCURRENT_AGENTS: 3 } }));
vi.mock("../lib/dispatch-trigger.js", () => ({
  drainOldestPendingTrigger: (...args: any[]) => drain(...args),
}));
vi.mock("../lib/trigger-delivery-store.js", () => ({
  deletePendingTrigger: (...args: any[]) => deletePending(...args),
  acknowledgeStartedTriggerDelivery: (...args: any[]) => acknowledgeStartedDelivery(...args),
}));
vi.mock("../clarifications/store.js", () => ({
  recordDispatchedRun: (...args: unknown[]) => recordDispatched(...args),
  clearDispatchedRun: (...args: unknown[]) => clearDispatched(...args),
  getClarification: (...args: unknown[]) => getClarification(...args),
  markClarificationCheckpointConsumed: (...args: unknown[]) => markConsumed(...args),
}));
vi.mock("../lib/telemetry/run-telemetry.js", () => ({
  resolveAwaitingRun: (...args: unknown[]) => resolveAwaitingRun(...args),
}));
vi.mock("../approvals/store.js", () => ({
  setDispatchedRunId: (...args: any[]) => setApprovalRun(...args),
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: any[]) => stopSandboxes(...args),
}));

describe("workflow owner steps", () => {
  beforeEach(() => {
    bindRun.mockReset();
    release.mockReset();
    drain.mockReset();
    deletePending.mockReset();
    recordDispatched.mockReset();
    clearDispatched.mockReset();
    getClarification.mockReset();
    markConsumed.mockReset();
    resolveAwaitingRun.mockReset();
    acknowledgeStartedDelivery.mockReset();
    setApprovalRun.mockReset();
    listSandboxes.mockReset().mockResolvedValue([]);
    stopSandboxes.mockReset().mockResolvedValue(0);
  });

  it("self-records the exact plan-approval workflow after owner bind", async () => {
    setApprovalRun.mockResolvedValue(undefined);
    const { acknowledgeApprovalDispatchStep } = await import("./run-ownership-steps.js");
    const entry = {
      kind: "plan_approved" as const,
      approval: { approvalRequestId: "approval-1" },
    } as any;

    await acknowledgeApprovalDispatchStep(entry, "run-approved");

    expect(setApprovalRun).toHaveBeenCalledWith({ db: true }, "approval-1", "run-approved");
  });

  it("acknowledges a drained pending identity after owner bind and before work", async () => {
    deletePending.mockResolvedValue(true);
    const { acknowledgePendingTriggerStep } = await import("./run-ownership-steps.js");
    const entry = {
      kind: "pr_trigger" as const,
      triggerType: "trigger_pr_created" as const,
      subjectKey: "pr:github:acme/api#7",
      ownerToken: "owner",
      definitionId: 1,
      definitionVersion: 2,
      scope: "any" as const,
      pendingEvent: {
        headSha: "sha",
        triggerType: "trigger_pr_created" as const,
        deliveryId: "delivery-1",
      },
      pr: { provider: "github", headSha: "sha" } as any,
    };
    await acknowledgePendingTriggerStep(entry);
    expect(deletePending).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        subjectKey: "pr:github:acme/api#7",
        triggerType: "trigger_pr_created",
        delivery: {
          provider: "github",
          producer: "pending-snapshot",
          deliveryId: "delivery-1",
        },
      }),
    );
  });

  it("does not acknowledge dispatcher identity on a restored clarification origin", async () => {
    const { acknowledgePendingTriggerStep } = await import("./run-ownership-steps.js");
    await acknowledgePendingTriggerStep({
      kind: "pr_trigger",
      triggerType: "trigger_pr_review",
      subjectKey: "pr:github:acme/api:7",
      ownerToken: "owner-successor",
      definitionId: 1,
      definitionVersion: 2,
      scope: "any",
      pendingEvent: {
        headSha: "sha",
        triggerType: "trigger_pr_review",
        deliveryId: "delivery-1",
      },
      delivery: { provider: "github", producer: "alice", deliveryId: "delivery-1" },
      continuation: { kind: "clarification", clarificationRequestId: "clar-1" },
      pr: { provider: "github", headSha: "sha" } as any,
    });
    expect(deletePending).not.toHaveBeenCalled();
  });

  it("records the winning PR-trigger run and removes only its exact pending snapshot", async () => {
    acknowledgeStartedDelivery.mockResolvedValue(true);
    const { acknowledgePrTriggerDispatchStep } = await import("./run-ownership-steps.js");
    const entry = {
      kind: "pr_trigger" as const,
      triggerType: "trigger_pr_checks_failed" as const,
      subjectKey: "pr:github:acme/api#7",
      ownerToken: "owner",
      definitionId: 1,
      definitionVersion: 2,
      scope: "any" as const,
      delivery: {
        provider: "github" as const,
        producer: "github-actions",
        deliveryId: "delivery-direct",
      },
      pr: { provider: "github" as const, headSha: "sha" } as any,
    };

    await expect(acknowledgePrTriggerDispatchStep(entry, "run-winning")).resolves.toBe(true);

    expect(acknowledgeStartedDelivery).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        subjectKey: entry.subjectKey,
        triggerType: entry.triggerType,
        delivery: entry.delivery,
        pr: entry.pr,
      }),
      "run-winning",
    );
  });

  it("rejects a PR-trigger candidate whose delivery belongs to another winner", async () => {
    acknowledgeStartedDelivery.mockResolvedValue(false);
    const { acknowledgePrTriggerDispatchStep } = await import("./run-ownership-steps.js");
    const entry = {
      kind: "pr_trigger" as const,
      triggerType: "trigger_pr_review" as const,
      subjectKey: "ticket:jira:AIW-1",
      delivery: {
        provider: "github" as const,
        producer: "alice",
        deliveryId: "delivery-stale",
      },
      pr: { provider: "github" as const, headSha: "sha" } as any,
    } as any;

    await expect(acknowledgePrTriggerDispatchStep(entry, "run-loser")).resolves.toBe(false);
  });

  it("lets only the candidate that CAS-binds continue", async () => {
    bindRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { bindWorkflowCandidateStep } = await import("./run-ownership-steps.js");
    expect(await bindWorkflowCandidateStep("subject", "owner", "run-a")).toBe(true);
    expect(await bindWorkflowCandidateStep("subject", "owner", "run-b")).toBe(false);
    expect(bindRun).toHaveBeenNthCalledWith(1, "subject", "owner", "run-a");
  });

  it("acknowledges and clears only through the exact clarification winner CAS", async () => {
    recordDispatched.mockResolvedValue(true);
    clearDispatched.mockResolvedValue(true);
    getClarification.mockResolvedValue({
      runId: "run-parked",
      dispatchedRunId: "run-winner",
    });
    resolveAwaitingRun.mockResolvedValue(true);
    const {
      clearClarificationDispatchWinnerStep,
      recordClarificationDispatchWinnerStep,
    } = await import("./run-ownership-steps.js");

    expect(await recordClarificationDispatchWinnerStep(
      "clar-1",
      "owner-successor",
      "run-winner",
    )).toBe(true);
    expect(recordDispatched).toHaveBeenCalledWith(
      { db: true },
      "clar-1",
      "owner-successor",
      "run-winner",
    );
    expect(resolveAwaitingRun).toHaveBeenCalledWith({ db: true }, "run-parked");
    expect(await clearClarificationDispatchWinnerStep(
      "clar-1",
      "owner-successor",
      "run-winner",
    )).toBe(true);
    expect(clearDispatched).toHaveBeenCalledWith(
      { db: true },
      "clar-1",
      "owner-successor",
      "run-winner",
    );
  });

  it("durably consumes the checkpoint before downstream side effects can run", async () => {
    markConsumed.mockResolvedValue(true);
    const { consumeClarificationCheckpointStep } = await import(
      "./run-ownership-steps.js"
    );

    await expect(consumeClarificationCheckpointStep(
      "clar-1",
      "owner-successor",
      "run-winner",
    )).resolves.toBeUndefined();
    expect(markConsumed).toHaveBeenCalledWith(
      { db: true },
      "clar-1",
      "owner-successor",
      "run-winner",
    );
  });

  it("does not reject the bound winner when predecessor telemetry is unavailable", async () => {
    recordDispatched.mockResolvedValue(true);
    getClarification.mockResolvedValue({
      runId: "run-parked",
      dispatchedRunId: "run-winner",
    });
    resolveAwaitingRun.mockRejectedValue(new Error("telemetry unavailable"));
    const { recordClarificationDispatchWinnerStep } = await import(
      "./run-ownership-steps.js"
    );

    await expect(recordClarificationDispatchWinnerStep(
      "clar-1",
      "owner-successor",
      "run-winner",
    )).resolves.toBe(true);
  });

  it("drains only when owner-matching terminal compare-and-delete succeeds", async () => {
    release.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { terminalReleaseAndDrainStep } = await import("./run-ownership-steps.js");
    expect(await terminalReleaseAndDrainStep("subject", "owner", "run-a")).toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expect(await terminalReleaseAndDrainStep("subject", "owner", "run-a")).toBe(true);
    expect(drain).toHaveBeenCalledOnce();
  });

  it("retains terminal ownership when durable sandbox cleanup is unconfirmed", async () => {
    listSandboxes.mockResolvedValue(["sbx-1"]);
    stopSandboxes.mockRejectedValue(new Error("sandbox API unavailable"));
    const { terminalReleaseAndDrainStep } = await import("./run-ownership-steps.js");

    expect(await terminalReleaseAndDrainStep("subject", "owner", "run-a")).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });
});
