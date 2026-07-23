import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveRunOwnerError } from "../lib/run-control-errors.js";

const bindRun = vi.fn();
const beginParking = vi.fn();
const finishParking = vi.fn();
const getRunOwner = vi.fn();
const deletePending = vi.fn();
const recordDispatched = vi.fn();
const clearDispatched = vi.fn();
const getClarification = vi.fn();
const assertClarificationCheckpointAvailable = vi.fn();
const markConsumed = vi.fn();
const resolveAwaitingRun = vi.fn();
const acknowledgeStartedDelivery = vi.fn();
const completeTriggerDelivery = vi.fn();
const createRepositoryVcsRuntime = vi.fn();
const getPRHead = vi.fn();
const getLatestCheckRuns = vi.fn();
const setApprovalRun = vi.fn();
const listSandboxes = vi.fn();
const stopSandboxes = vi.fn();
const updateLabels = vi.fn();
const assertActiveRunOwner = vi.fn();
const moveTicket = vi.fn();
const fetchTicket = vi.fn();
const updateTicketLabels = vi.fn();
const acknowledgeManualDispatch = vi.fn();
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    runRegistry: {
      bindRun,
      beginParking,
      finishParking,
      get: getRunOwner,
      listSandboxes,
    },
    issueTracker: { updateLabels, fetchTicket },
  }),
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => assertActiveRunOwner(...args),
}));
vi.mock("../lib/trigger-delivery-store.js", () => ({
  deletePendingTrigger: (...args: any[]) => deletePending(...args),
  acknowledgeStartedTriggerDelivery: (...args: any[]) => acknowledgeStartedDelivery(...args),
  completeTriggerDelivery: (...args: any[]) => completeTriggerDelivery(...args),
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: (...args: any[]) => {
    createRepositoryVcsRuntime(...args);
    return { getPRHead, getLatestCheckRuns };
  },
  createRepositoryVcsRuntime: (...args: any[]) => {
    createRepositoryVcsRuntime(...args);
    return { vcs: { getPRHead, getLatestCheckRuns } };
  },
}));
vi.mock("../clarifications/store.js", () => ({
  assertClarificationCheckpointAvailable: (...args: unknown[]) =>
    assertClarificationCheckpointAvailable(...args),
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
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketForRun: (...args: any[]) => moveTicket(...args),
}));
vi.mock("../lib/ticket-label-mutation.js", () => ({
  updateTicketLabelsForRun: (...args: any[]) =>
    updateTicketLabels(...args),
}));
vi.mock("../manual-dispatch/service.js", () => ({
  acknowledgeManualDispatchWorkflow: (...args: unknown[]) =>
    acknowledgeManualDispatch(...args),
}));

describe("workflow owner steps", () => {
  beforeEach(() => {
    bindRun.mockReset();
    beginParking.mockReset().mockResolvedValue(true);
    finishParking.mockReset().mockResolvedValue(true);
    getRunOwner.mockReset().mockResolvedValue(null);
    deletePending.mockReset();
    recordDispatched.mockReset();
    clearDispatched.mockReset();
    getClarification.mockReset();
    assertClarificationCheckpointAvailable.mockReset();
    markConsumed.mockReset();
    resolveAwaitingRun.mockReset();
    acknowledgeStartedDelivery.mockReset();
    completeTriggerDelivery.mockReset().mockResolvedValue(undefined);
    createRepositoryVcsRuntime.mockReset();
    getPRHead.mockReset().mockResolvedValue({
      headSha: "sha",
      baseRef: "main",
      state: "open",
    });
    getLatestCheckRuns.mockReset().mockResolvedValue([
      {
        id: 101,
        name: "ci / build",
        appSlug: "github-actions",
        status: "completed",
        conclusion: "failure",
      },
    ]);
    setApprovalRun.mockReset();
    listSandboxes.mockReset().mockResolvedValue([]);
    stopSandboxes.mockReset().mockResolvedValue(0);
    updateLabels.mockReset();
    assertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    moveTicket.mockReset().mockResolvedValue(undefined);
    fetchTicket.mockReset();
    updateTicketLabels.mockReset().mockResolvedValue(undefined);
    acknowledgeManualDispatch.mockReset().mockResolvedValue(true);
  });

  it("acknowledges a manual request after the workflow wins owner binding", async () => {
    const { acknowledgeManualDispatchStep } = await import(
      "./run-ownership-steps.js"
    );
    await acknowledgeManualDispatchStep(
      {
        kind: "ticket",
        subjectKey: "ticket:jira:AIW-173",
        ticketKey: "AIW-173",
        ownerToken: "owner-1",
        manualDispatchId: "dispatch-1",
      },
      "run-1",
    );

    expect(acknowledgeManualDispatch).toHaveBeenCalledWith(
      { db: true },
      {
        requestId: "dispatch-1",
        ownerToken: "owner-1",
        runId: "run-1",
      },
    );
  });

  it("fails closed when a manual request cannot acknowledge the bound owner", async () => {
    acknowledgeManualDispatch.mockResolvedValue(false);
    const { acknowledgeManualDispatchStep } = await import(
      "./run-ownership-steps.js"
    );
    await expect(
      acknowledgeManualDispatchStep(
        {
          kind: "ticket",
          subjectKey: "ticket:jira:AIW-173",
          ticketKey: "AIW-173",
          ownerToken: "owner-1",
          manualDispatchId: "dispatch-1",
        },
        "run-loser",
      ),
    ).rejects.toThrow("could not be acknowledged");
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
      pr: {
        provider: "github" as const,
        repoPath: "acme/api",
        prNumber: 7,
        headSha: "sha",
        baseRef: "main",
        failedChecks: [{
          name: "ci / build",
          appSlug: "github-actions",
          checkRunId: 101,
          conclusion: "failure",
        }],
      } as any,
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
    expect(createRepositoryVcsRuntime).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    expect(getPRHead).toHaveBeenCalledWith(7);
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
      pr: {
        provider: "github" as const,
        repoPath: "acme/api",
        prNumber: 7,
        headSha: "sha",
        baseRef: "main",
      } as any,
    } as any;

    await expect(acknowledgePrTriggerDispatchStep(entry, "run-loser")).resolves.toBe(false);
  });

  it.each([
    ["head", { headSha: "sha-new", baseRef: "main", state: "open" }],
    ["base", { headSha: "sha", baseRef: "release", state: "open" }],
    ["state", { headSha: "sha", baseRef: "main", state: "closed" }],
  ] as const)(
    "rejects a bound PR-trigger candidate when the provider %s identity changed",
    async (_identity, current) => {
      getPRHead.mockResolvedValue(current);
      const { acknowledgePrTriggerDispatchStep } = await import(
        "./run-ownership-steps.js"
      );
      const entry = {
        kind: "pr_trigger" as const,
        triggerType: "trigger_pr_review" as const,
        subjectKey: "pr:github:acme/api#7",
        ownerToken: "owner",
        definitionId: 1,
        definitionVersion: 2,
        scope: "any" as const,
        delivery: {
          provider: "github" as const,
          producer: "alice",
          deliveryId: "delivery-stale-provider",
        },
        pr: {
          provider: "github" as const,
          repoPath: "acme/api",
          prNumber: 7,
          headSha: "sha",
          baseRef: "main",
        } as any,
      };

      await expect(
        acknowledgePrTriggerDispatchStep(entry, "run-stale"),
      ).resolves.toBe(false);
      expect(acknowledgeStartedDelivery).not.toHaveBeenCalled();
      expect(completeTriggerDelivery).toHaveBeenCalledWith(
        { db: true },
        "github",
        "delivery-stale-provider",
        { result: "ignored_stale_head" },
      );
    },
  );

  it("rejects a same-head GitHub checks candidate after its exact Check Run passes", async () => {
    acknowledgeStartedDelivery.mockResolvedValue(true);
    getLatestCheckRuns.mockResolvedValue([
      {
        id: 101,
        name: "ci / build",
        appSlug: "github-actions",
        status: "completed",
        conclusion: "success",
      },
    ]);
    const { acknowledgePrTriggerDispatchStep } = await import(
      "./run-ownership-steps.js"
    );
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
        deliveryId: "delivery-passed-check",
      },
      pr: {
        provider: "github" as const,
        repoPath: "acme/api",
        prNumber: 7,
        headSha: "sha",
        baseRef: "main",
        failedChecks: [{
          name: "ci / build",
          appSlug: "github-actions",
          checkRunId: 101,
          conclusion: "failure",
        }],
      } as any,
    };

    await expect(
      acknowledgePrTriggerDispatchStep(entry, "run-stale-check"),
    ).resolves.toBe(false);
    expect(getLatestCheckRuns).toHaveBeenCalledWith("sha");
    expect(acknowledgeStartedDelivery).not.toHaveBeenCalled();
    expect(completeTriggerDelivery).toHaveBeenCalledWith(
      { db: true },
      "github",
      "delivery-passed-check",
      { result: "ignored_stale_head" },
    );
  });

  it("rejects a same-head GitLab checks candidate after its pipeline passes", async () => {
    acknowledgeStartedDelivery.mockResolvedValue(true);
    getPRHead.mockResolvedValue({
      headSha: "sha",
      baseRef: "main",
      state: "open",
      headPipelineId: 901,
      headPipelineStatus: "success",
    });
    const { acknowledgePrTriggerDispatchStep } = await import(
      "./run-ownership-steps.js"
    );
    const entry = {
      kind: "pr_trigger" as const,
      triggerType: "trigger_pr_checks_failed" as const,
      subjectKey: "pr:gitlab:group/api#7",
      ownerToken: "owner",
      definitionId: 1,
      definitionVersion: 2,
      scope: "any" as const,
      delivery: {
        provider: "gitlab" as const,
        producer: "gitlab-ci",
        deliveryId: "delivery-passed-pipeline",
      },
      pr: {
        provider: "gitlab" as const,
        repoPath: "group/api",
        prNumber: 7,
        headSha: "sha",
        baseRef: "main",
        pipelineId: 901,
        failedChecks: [{ name: "lint", conclusion: "failed" }],
      } as any,
    };

    await expect(
      acknowledgePrTriggerDispatchStep(entry, "run-stale-pipeline"),
    ).resolves.toBe(false);
    expect(acknowledgeStartedDelivery).not.toHaveBeenCalled();
    expect(completeTriggerDelivery).toHaveBeenCalledWith(
      { db: true },
      "gitlab",
      "delivery-passed-pipeline",
      { result: "ignored_stale_head" },
    );
  });

  it("lets only the candidate that CAS-binds continue", async () => {
    bindRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { bindWorkflowCandidateStep } = await import("./run-ownership-steps.js");
    expect(await bindWorkflowCandidateStep("subject", "owner", "run-a")).toBe(true);
    expect(await bindWorkflowCandidateStep("subject", "owner", "run-b")).toBe(false);
    expect(bindRun).toHaveBeenNthCalledWith(1, "subject", "owner", "run-a");
  });

  it("crosses the durable parking barrier only after every registered sandbox stop is confirmed", async () => {
    const order: string[] = [];
    beginParking.mockImplementation(async () => {
      order.push("begin");
      return true;
    });
    listSandboxes.mockImplementation(async () => {
      order.push("list");
      return ["sbx-code", "sbx-scratch"];
    });
    stopSandboxes.mockImplementation(async () => {
      order.push("stop");
      return 2;
    });
    finishParking.mockImplementation(async () => {
      order.push("finish");
      return true;
    });
    const { parkClarificationOwnerStep } = await import("./run-ownership-steps.js");

    await expect(
      parkClarificationOwnerStep("ticket:jira:AWT-1", "owner-a", "run-a"),
    ).resolves.toBe(true);
    expect(order).toEqual(["begin", "list", "stop", "finish"]);
  });

  it("keeps the durable parking claim for reconciliation when sandbox termination is unconfirmed", async () => {
    listSandboxes.mockResolvedValue(["sbx-code"]);
    stopSandboxes.mockRejectedValue(new Error("sandbox still running"));
    const { parkClarificationOwnerStep } = await import("./run-ownership-steps.js");

    await expect(
      parkClarificationOwnerStep("ticket:jira:AWT-1", "owner-a", "run-a"),
    ).resolves.toBe(true);
    expect(finishParking).not.toHaveBeenCalled();
  });

  it("keeps the published clarification awaiting when beginParking is temporarily unavailable", async () => {
    beginParking.mockRejectedValue(new Error("database unavailable"));
    const { parkClarificationOwnerStep } = await import("./run-ownership-steps.js");

    await expect(
      parkClarificationOwnerStep("ticket:jira:AWT-1", "owner-a", "run-a"),
    ).resolves.toBe(true);
    expect(listSandboxes).not.toHaveBeenCalled();
    expect(finishParking).not.toHaveBeenCalled();
  });

  it("accepts a concurrent reconciler that already completed parking", async () => {
    listSandboxes.mockResolvedValue(["sbx-code"]);
    finishParking.mockResolvedValue(false);
    getRunOwner.mockResolvedValue({
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-a",
      runId: "run-a",
      state: "parked",
    });
    const { parkClarificationOwnerStep } = await import("./run-ownership-steps.js");

    await expect(
      parkClarificationOwnerStep("ticket:jira:AWT-1", "owner-a", "run-a"),
    ).resolves.toBe(true);
  });

  it("treats an exact already-parked replay as complete", async () => {
    beginParking.mockResolvedValue(false);
    getRunOwner.mockResolvedValue({
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-a",
      runId: "run-a",
      state: "parked",
    });
    const { parkClarificationOwnerStep } = await import("./run-ownership-steps.js");

    await expect(
      parkClarificationOwnerStep("ticket:jira:AWT-1", "owner-a", "run-a"),
    ).resolves.toBe(true);
    expect(listSandboxes).not.toHaveBeenCalled();
    expect(finishParking).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelling", "owner-a", "run-a"],
    ["reserved", "owner-successor", null],
  ] as const)(
    "rejects %s ownership instead of reporting a successful clarification park",
    async (state, ownerToken, runId) => {
      beginParking.mockResolvedValue(false);
      getRunOwner.mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken,
        runId,
        state,
      });
      const { parkClarificationOwnerStep } = await import("./run-ownership-steps.js");

      await expect(
        parkClarificationOwnerStep("ticket:jira:AWT-1", "owner-a", "run-a"),
      ).rejects.toBeInstanceOf(ActiveRunOwnerError);
      expect(listSandboxes).not.toHaveBeenCalled();
      expect(finishParking).not.toHaveBeenCalled();
    },
  );

  it("repairs clarification label removal independently and replay-safely", async () => {
    updateTicketLabels
      .mockRejectedValueOnce(new Error("Jira is temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const { repairClarificationLabelStep } = await import("./run-ownership-steps.js");

    const owner = {
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner:test",
      runId: "run-1",
    };
    await expect(repairClarificationLabelStep("AWT-1", owner)).rejects.toThrow(
      "Jira is temporarily unavailable",
    );
    await expect(repairClarificationLabelStep("AWT-1", owner)).resolves.toBeUndefined();
    expect(updateTicketLabels).toHaveBeenCalledTimes(2);
    expect(updateTicketLabels).toHaveBeenLastCalledWith({
      db: { db: true },
      issueTracker: expect.anything(),
      ticketKey: "AWT-1",
      owner,
      requiredOwnerState: "bound",
      changes: { remove: ["needs-clarification"] },
    });
    expect(updateLabels).not.toHaveBeenCalled();
  });

  it("does not remove the clarification label after cancellation closes the owner", async () => {
    const ownerLoss = new ActiveRunOwnerError();
    updateTicketLabels.mockRejectedValue(ownerLoss);
    const { repairClarificationLabelStep } = await import("./run-ownership-steps.js");

    await expect(
      repairClarificationLabelStep("AWT-1", {
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner:test",
        runId: "run-1",
      }),
    ).rejects.toBe(ownerLoss);

    expect(updateTicketLabels).toHaveBeenCalledOnce();
    expect(updateLabels).not.toHaveBeenCalled();
  });
});
