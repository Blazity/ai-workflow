import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepsRecord } from "../../workflow-definition/interpreter.js";

const mocks = vi.hoisted(() => ({
  createApprovalRequest: vi.fn(),
  postComment: vi.fn(),
  notifyForTicket: vi.fn(),
  moveTicket: vi.fn(),
  updateLabels: vi.fn(),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../approvals/store.js", () => ({ createApprovalRequest: mocks.createApprovalRequest }));
vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    issueTracker: {
      postComment: mocks.postComment,
      moveTicket: mocks.moveTicket,
      updateLabels: mocks.updateLabels,
    },
    messaging: { notifyForTicket: mocks.notifyForTicket },
  }),
}));

import { execute, paramsSchema } from "./send-plan-approval.js";
import { AWAITING_APPROVAL_LABEL } from "../../lib/labels.js";
import { makeCtx, makeNode } from "./test-support.js";

describe("send_plan_approval paramsSchema", () => {
  it("defaults mirrorComment to true and allows an optional planFromStep", () => {
    expect(paramsSchema.parse({})).toEqual({ mirrorComment: true });
    expect(paramsSchema.safeParse({ planFromStep: "plan", mirrorComment: false }).success).toBe(true);
    expect(paramsSchema.safeParse({ planFromStep: "" }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("send_plan_approval execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createApprovalRequest.mockResolvedValue({ id: "appr-9" });
    mocks.postComment.mockResolvedValue(null);
    mocks.notifyForTicket.mockResolvedValue(undefined);
    mocks.moveTicket.mockResolvedValue(undefined);
    mocks.updateLabels.mockResolvedValue(undefined);
  });

  it("fails when no plan is available", async () => {
    const result = await execute(
      makeNode("send_plan_approval"),
      {},
      makeCtx({ researchPlanMarkdown: "" }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("no plan available");
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  it("fails when the run has no stored definition", async () => {
    const result = await execute(
      makeNode("send_plan_approval"),
      {},
      makeCtx({ researchPlanMarkdown: "# Plan", definitionId: null }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("approval requires a stored definition");
  });

  it("stores the plan, mirrors a comment, notifies, unregisters, parks the ticket, and ends", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Research plan" });
    const result = await execute(makeNode("send_plan_approval"), {}, ctx);

    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(expect.anything(), {
      ticketKey: "AWT-1",
      definitionId: 1,
      runId: "run-1",
      plan: { markdown: "# Research plan" },
      assumptions: null,
    });
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      "Plan awaiting approval in the dashboard.",
    );
    expect(mocks.notifyForTicket).toHaveBeenCalledWith("AWT-1", { kind: "plan_approval_requested" });
    expect(ctx.unregisterBeforePr).toHaveBeenCalledOnce();
    // Parked out of the AI column with an awaiting-approval label so the cron
    // poll stops re-dispatching it; label add precedes the move, mirroring
    // clarification, and the move follows the unregister.
    expect(mocks.updateLabels).toHaveBeenCalledWith("AWT-1", { add: [AWAITING_APPROVAL_LABEL] });
    expect(mocks.moveTicket).toHaveBeenCalledWith("AWT-1", "Backlog");
    const unregisterOrder = (ctx.unregisterBeforePr as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0];
    expect(unregisterOrder).toBeLessThan(mocks.moveTicket.mock.invocationCallOrder[0]);
    expect(result).toEqual({
      kind: "ended",
      output: { status: "awaiting_approval", approvalRequestId: "appr-9" },
    });
  });

  it("prefers a referenced step's plan and string assumptions over the research plan", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Research plan" });
    const steps: StepsRecord = {
      planner: { output: { status: "ready", plan: "# Step plan", assumptions: ["db is seeded", 3] } },
    };
    await execute(makeNode("send_plan_approval", { planFromStep: "planner" }), steps, ctx);
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan: { markdown: "# Step plan" }, assumptions: ["db is seeded"] }),
    );
  });

  it("skips the mirror comment when mirrorComment is false", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Plan" });
    await execute(makeNode("send_plan_approval", { mirrorComment: false }), {}, ctx);
    expect(mocks.postComment).not.toHaveBeenCalled();
    expect(mocks.notifyForTicket).toHaveBeenCalledOnce();
  });
});
