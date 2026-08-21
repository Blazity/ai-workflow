import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveRunOwnerError } from "../lib/run-control-errors.js";

const mocks = vi.hoisted(() => ({
  assertActiveRunOwner: vi.fn(),
  fetchTicket: vi.fn(),
  findCommentByMarker: vi.fn(),
  info: vi.fn(),
  getRunAnalysisReport: vi.fn(),
  moveTicket: vi.fn(),
  notifyForTicket: vi.fn(),
  postComment: vi.fn(),
  recordRunAnalysisReport: vi.fn(),
  reconcileClarificationPickupState: vi.fn(),
  resolveAwaitingRunsForTicket: vi.fn(),
  supersedePendingForTicket: vi.fn(),
  updateTicketLabels: vi.fn(),
  updateLabels: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
}));
vi.mock("../lib/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: {
      fetchTicket: mocks.fetchTicket,
      findCommentByMarker: mocks.findCommentByMarker,
      postComment: mocks.postComment,
      updateLabels: mocks.updateLabels,
    },
    messaging: { notifyForTicket: mocks.notifyForTicket },
  }),
}));
vi.mock("../clarifications/store.js", () => ({
  reconcileClarificationPickupState: (...args: any[]) =>
    mocks.reconcileClarificationPickupState(...args),
  supersedePendingForTicket: (...args: any[]) => mocks.supersedePendingForTicket(...args),
}));
vi.mock("../lib/telemetry/run-telemetry.js", () => ({
  resolveAwaitingRunsForTicket: (...args: any[]) =>
    mocks.resolveAwaitingRunsForTicket(...args),
}));
vi.mock("../lib/ticket-transition.js", () => ({
  moveTicketForRun: (...args: any[]) => mocks.moveTicket(...args),
}));
vi.mock("../lib/ticket-label-mutation.js", () => ({
  updateTicketLabelsForRun: (...args: any[]) =>
    mocks.updateTicketLabels(...args),
}));
vi.mock("../lib/logger.js", () => ({ logger: { info: mocks.info, warn: mocks.warn } }));
vi.mock("../run-analysis/store.js", () => ({
  getRunAnalysisReport: (...args: any[]) => mocks.getRunAnalysisReport(...args),
  recordRunAnalysisReport: (...args: any[]) => mocks.recordRunAnalysisReport(...args),
}));
vi.mock("../../env.js", () => ({
  env: { DASHBOARD_ORIGIN: "https://dashboard.example.com" },
}));

import {
  agentWorkflow,
  clarificationExitDisposition,
  notifyTicket,
  notifyTicketBestEffort,
  loadApprovedPlanAnalysisReportBestEffort,
  parkForClarificationStep,
  postPickupCommentStep,
  postPrLinksComment,
  postRunAnalysisCommentStep,
  postTicketComment,
  recordRunAnalysisReportBestEffort,
  reconcileClarificationsOnPickup,
} from "./agent.js";
import { runControlErrorCases } from "./blocks/test-support.js";
import { buildResearchAnalysisReport } from "../run-analysis/report.js";

const owner = {
  subjectKey: "ticket:jira:AWT-1",
  ownerToken: "owner:test",
  runId: "run-1",
};

const analysisReport = buildResearchAnalysisReport({
  runId: "run-1",
  capturedAt: "2026-08-20T00:00:00.000Z",
  researchResult: { body: "Implement the ticket." },
  usage: {
    costUsd: 0.25,
    costKnown: true,
    tokensInput: 10,
    tokensCached: 0,
    tokensOutput: 5,
    phases: {},
  },
});

describe("agent provider side-effect fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
    mocks.fetchTicket.mockResolvedValue({ comments: [] });
    mocks.findCommentByMarker.mockResolvedValue(null);
    mocks.getRunAnalysisReport.mockResolvedValue(null);
    mocks.moveTicket.mockResolvedValue(undefined);
    mocks.notifyForTicket.mockResolvedValue(undefined);
    mocks.postComment.mockResolvedValue(null);
    mocks.recordRunAnalysisReport.mockResolvedValue(undefined);
    mocks.reconcileClarificationPickupState.mockResolvedValue({
      superseded: 0,
      resolvedAwaiting: 0,
    });
    mocks.resolveAwaitingRunsForTicket.mockResolvedValue(undefined);
    mocks.supersedePendingForTicket.mockResolvedValue(undefined);
    mocks.updateTicketLabels.mockResolvedValue(undefined);
    mocks.updateLabels.mockResolvedValue(undefined);
  });

  it("leaves terminal owner release to post-Workflow reconciliation", () => {
    expect(agentWorkflow.toString()).not.toContain("terminalReleaseAndDrainStep");
  });

  it("reasserts exact ownership immediately before Jira comments and Slack notifications", async () => {
    const order: string[] = [];
    mocks.assertActiveRunOwner.mockImplementation(async () => {
      order.push("fence");
    });
    mocks.postComment.mockImplementation(async () => {
      order.push("comment");
      return null;
    });
    mocks.notifyForTicket.mockImplementation(async () => {
      order.push("notify");
    });

    await postTicketComment("AWT-1", "Done", owner);
    await notifyTicket("AWT-1", { kind: "started" }, owner);
    await postPrLinksComment(
      "AWT-1",
      [{ provider: "github", repoPath: "acme/api", url: "https://pr/1", id: 1 }],
      owner,
    );
    await postPickupCommentStep("AWT-1", owner);

    expect(order).toEqual([
      "fence",
      "comment",
      "fence",
      "notify",
      "fence",
      "comment",
      "fence",
      "comment",
    ]);
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledTimes(4);
    for (const call of mocks.assertActiveRunOwner.mock.calls) {
      expect(call).toEqual([{ kind: "db" }, owner]);
    }
  });

  it("posts one analysis comment and recovers a replay from the paginated marker lookup", async () => {
    mocks.postComment.mockResolvedValueOnce("https://jira.example/comment/1");

    await expect(
      postRunAnalysisCommentStep("AWT-1", analysisReport, "research", owner),
    ).resolves.toMatchObject({
      state: "posted",
      commentUrl: "https://jira.example/comment/1",
    });
    expect(mocks.findCommentByMarker).toHaveBeenCalledWith(
      "AWT-1",
      "Arthur report: run-1:research",
    );
    expect(mocks.postComment).toHaveBeenCalledOnce();
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
    mocks.findCommentByMarker.mockResolvedValue(
      "https://jira.example/comment/1",
    );

    await expect(
      postRunAnalysisCommentStep("AWT-1", analysisReport, "research", owner),
    ).resolves.toMatchObject({
      state: "posted",
      commentUrl: "https://jira.example/comment/1",
    });
    expect(mocks.postComment).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", stage: "research" }),
      "run_analysis_comment_skipped_duplicate",
    );
  });

  it("keeps report persistence and approved-report loading best-effort", async () => {
    mocks.recordRunAnalysisReport.mockRejectedValue(new Error("database unavailable"));
    await expect(recordRunAnalysisReportBestEffort(analysisReport)).resolves.toBe(false);

    mocks.getRunAnalysisReport.mockRejectedValue(new Error("database unavailable"));
    await expect(loadApprovedPlanAnalysisReportBestEffort(
      "continuation",
      "source",
      {
        kind: "plan_approved",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        approvedPlan: { markdown: "Approved", sourceRunId: "source" },
        approval: {
          approvalRequestId: "approval-1",
          approver: "reviewer@example.com",
          approvedAt: "2026-08-20T00:00:00.000Z",
        },
      },
    )).resolves.toBeNull();
  });

  it("rechecks ownership after marker lookup and before posting Jira", async () => {
    mocks.assertActiveRunOwner
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ActiveRunOwnerError("owner changed"));

    await expect(
      postRunAnalysisCommentStep("AWT-1", analysisReport, "research", owner),
    ).rejects.toThrow("owner changed");
    expect(mocks.findCommentByMarker).toHaveBeenCalledOnce();
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("prevents stale Jira comments and Slack notifications after cancellation", async () => {
    mocks.assertActiveRunOwner.mockRejectedValue(
      new Error("Provider mutation requires the exact active run owner."),
    );

    await expect(postTicketComment("AWT-1", "Done", owner)).rejects.toThrow(/exact active/i);
    await expect(notifyTicket("AWT-1", { kind: "started" }, owner)).rejects.toThrow(
      /exact active/i,
    );
    await expect(
      postPrLinksComment(
        "AWT-1",
        [{ provider: "github", repoPath: "acme/api", url: "https://pr/1", id: 1 }],
        owner,
      ),
    ).resolves.toBeUndefined();
    await expect(postPickupCommentStep("AWT-1", owner)).resolves.toBeUndefined();

    expect(mocks.postComment).not.toHaveBeenCalled();
    expect(mocks.notifyForTicket).not.toHaveBeenCalled();
  });

  it.each(runControlErrorCases())(
    "does not swallow %s at best-effort ticket comment boundaries",
    async (_label, error) => {
      mocks.assertActiveRunOwner.mockRejectedValue(error);

      await expect(
        postPrLinksComment(
          "AWT-1",
          [{ provider: "github", repoPath: "acme/api", url: "https://pr/1", id: 1 }],
          owner,
        ),
      ).rejects.toBe(error);
      await expect(postPickupCommentStep("AWT-1", owner)).rejects.toBe(error);
      await expect(
        postRunAnalysisCommentStep("AWT-1", analysisReport, "research", owner),
      ).rejects.toBe(error);

      expect(mocks.postComment).not.toHaveBeenCalled();
    },
  );

  it.each(runControlErrorCases())(
    "does not swallow %s at the best-effort clarification notification boundary",
    async (_label, error) => {
      mocks.assertActiveRunOwner.mockRejectedValue(error);

      await expect(
        notifyTicketBestEffort("AWT-1", { kind: "started" }, owner),
      ).rejects.toBe(error);
      expect(mocks.notifyForTicket).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary clarification notification failures best-effort", async () => {
    mocks.assertActiveRunOwner.mockRejectedValue(new Error("Slack unavailable"));

    await expect(
      notifyTicketBestEffort("AWT-1", { kind: "started" }, owner),
    ).resolves.toBeUndefined();
    expect(mocks.notifyForTicket).not.toHaveBeenCalled();
  });

  it("routes clarification label changes through exact bound-owner mutations", async () => {
    const order: string[] = [];
    mocks.assertActiveRunOwner.mockImplementation(async () => {
      order.push("fence");
    });
    mocks.updateTicketLabels.mockImplementation(async () => {
      order.push("mutation");
    });
    mocks.reconcileClarificationPickupState.mockImplementation(async () => {
      order.push("pickup-state");
      return { superseded: 0, resolvedAwaiting: 0 };
    });
    mocks.updateLabels.mockImplementation(async () => {
      order.push("label");
    });

    await parkForClarificationStep("AWT-1", "Backlog", "clar-1", owner);
    await reconcileClarificationsOnPickup("AWT-1", "run-1", owner);

    expect(order).toEqual(["mutation", "mutation", "pickup-state"]);
    expect(mocks.updateTicketLabels).toHaveBeenNthCalledWith(1, {
      db: { kind: "db" },
      issueTracker: expect.anything(),
      ticketKey: "AWT-1",
      owner,
      requiredOwnerState: "bound",
      changes: { add: ["needs-clarification"] },
    });
    expect(mocks.updateTicketLabels).toHaveBeenNthCalledWith(2, {
      db: { kind: "db" },
      issueTracker: expect.anything(),
      ticketKey: "AWT-1",
      owner,
      requiredOwnerState: "bound",
      changes: { remove: ["needs-clarification"] },
    });
    expect(mocks.assertActiveRunOwner).not.toHaveBeenCalled();
    expect(mocks.updateLabels).not.toHaveBeenCalled();
    expect(mocks.reconcileClarificationPickupState).toHaveBeenCalledWith(
      { kind: "db" },
      { ticketKey: "AWT-1", currentRunId: "run-1", owner },
    );
    expect(mocks.supersedePendingForTicket).not.toHaveBeenCalled();
    expect(mocks.resolveAwaitingRunsForTicket).not.toHaveBeenCalled();
  });

  it("rethrows owner loss before parking, superseding, or telemetry can continue", async () => {
    const ownerLoss = new ActiveRunOwnerError();
    mocks.updateTicketLabels.mockRejectedValue(ownerLoss);

    await expect(
      parkForClarificationStep("AWT-1", "Backlog", "clar-1", owner),
    ).rejects.toBe(ownerLoss);
    await expect(
      reconcileClarificationsOnPickup("AWT-1", "run-1", owner),
    ).rejects.toBe(ownerLoss);

    expect(mocks.updateTicketLabels).toHaveBeenCalledTimes(2);
    expect(mocks.updateLabels).not.toHaveBeenCalled();
    expect(mocks.moveTicket).not.toHaveBeenCalled();
    expect(mocks.reconcileClarificationPickupState).not.toHaveBeenCalled();
    expect(mocks.supersedePendingForTicket).not.toHaveBeenCalled();
    expect(mocks.resolveAwaitingRunsForTicket).not.toHaveBeenCalled();
  });

  it("rethrows owner loss when cancellation wins after label success but before pickup housekeeping", async () => {
    const ownerLoss = new ActiveRunOwnerError();
    mocks.reconcileClarificationPickupState.mockRejectedValue(ownerLoss);

    await expect(
      reconcileClarificationsOnPickup("AWT-1", "run-1", owner),
    ).rejects.toBe(ownerLoss);

    expect(mocks.updateTicketLabels).toHaveBeenCalledOnce();
    expect(mocks.reconcileClarificationPickupState).toHaveBeenCalledOnce();
    expect(mocks.supersedePendingForTicket).not.toHaveBeenCalled();
    expect(mocks.resolveAwaitingRunsForTicket).not.toHaveBeenCalled();
  });

  it("keeps ordinary label provider failures best-effort", async () => {
    mocks.updateTicketLabels.mockRejectedValue(
      new Error("Jira labels are temporarily unavailable"),
    );

    await expect(
      parkForClarificationStep("AWT-1", "Backlog", "clar-1", owner),
    ).resolves.toBe(true);
    await expect(
      reconcileClarificationsOnPickup("AWT-1", "run-1", owner),
    ).resolves.toBeUndefined();

    expect(mocks.moveTicket).toHaveBeenCalledOnce();
    expect(mocks.reconcileClarificationPickupState).toHaveBeenCalledOnce();
    expect(mocks.supersedePendingForTicket).not.toHaveBeenCalled();
    expect(mocks.resolveAwaitingRunsForTicket).not.toHaveBeenCalled();
  });

  it("keeps the asking run awaiting when an early answer skips only provider parking", () => {
    expect(clarificationExitDisposition(false)).toEqual({
      outcome: "awaiting",
      notify: false,
    });
  });
});
