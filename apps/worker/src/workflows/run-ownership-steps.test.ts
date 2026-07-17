import { beforeEach, describe, expect, it, vi } from "vitest";

const bindRun = vi.fn();
const release = vi.fn();
const drain = vi.fn();
const deletePending = vi.fn();
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { bindRun, release } }),
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../../env.js", () => ({ env: { MAX_CONCURRENT_AGENTS: 3 } }));
vi.mock("../lib/dispatch-trigger.js", () => ({
  drainOldestPendingTrigger: (...args: any[]) => drain(...args),
}));
vi.mock("../lib/trigger-delivery-store.js", () => ({
  deletePendingTrigger: (...args: any[]) => deletePending(...args),
}));

describe("workflow owner steps", () => {
  beforeEach(() => {
    bindRun.mockReset();
    release.mockReset();
    drain.mockReset();
    deletePending.mockReset();
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
      pendingEvent: { headSha: "sha", triggerType: "trigger_pr_created" as const },
      pr: { headSha: "sha" } as any,
    };
    await acknowledgePendingTriggerStep(entry);
    expect(deletePending).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        subjectKey: "pr:github:acme/api#7",
        triggerType: "trigger_pr_created",
      }),
    );
  });

  it("lets only the candidate that CAS-binds continue", async () => {
    bindRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { bindWorkflowCandidateStep } = await import("./run-ownership-steps.js");
    expect(await bindWorkflowCandidateStep("subject", "owner", "run-a")).toBe(true);
    expect(await bindWorkflowCandidateStep("subject", "owner", "run-b")).toBe(false);
    expect(bindRun).toHaveBeenNthCalledWith(1, "subject", "owner", "run-a");
  });

  it("drains only when owner-matching terminal compare-and-delete succeeds", async () => {
    release.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { terminalReleaseAndDrainStep } = await import("./run-ownership-steps.js");
    expect(await terminalReleaseAndDrainStep("subject", "owner", "run-a")).toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expect(await terminalReleaseAndDrainStep("subject", "owner", "run-a")).toBe(true);
    expect(drain).toHaveBeenCalledOnce();
  });
});
