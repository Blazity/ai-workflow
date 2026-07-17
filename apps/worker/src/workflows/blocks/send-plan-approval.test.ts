import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepsRecord } from "../../workflow-definition/interpreter.js";

const mocks = vi.hoisted(() => ({
  createApprovalRequest: vi.fn(),
  postComment: vi.fn(),
  notifyForTicket: vi.fn(),
  moveTicket: vi.fn(),
  updateLabels: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({ logger: { warn: mocks.warn } }));
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
  it("defaults mirrorComment to true and rejects the retired planFromStep param", () => {
    expect(paramsSchema.parse({})).toEqual({ mirrorComment: true });
    expect(paramsSchema.safeParse({ mirrorComment: false }).success).toBe(true);
    expect(paramsSchema.safeParse({ planFromStep: "plan" }).success).toBe(false);
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
      definitionVersion: 1,
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

  it("pins the run's current definition version onto the request", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Plan", definitionId: 3, definitionVersion: 5 });
    await execute(makeNode("send_plan_approval"), {}, ctx);
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ definitionId: 3, definitionVersion: 5 }),
    );
  });

  it("prefers bound plan and string assumptions over the compatibility research plan", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Research plan" });
    await execute(makeNode("send_plan_approval"), {}, ctx, {
      plan: "# Step plan",
      assumptions: ["db is seeded", 3],
    });
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan: { markdown: "# Step plan" }, assumptions: ["db is seeded"] }),
    );
  });

  it("still ends awaiting_approval when parking the ticket fails", async () => {
    // The approval row is committed before the park; a tracker move failure must
    // not be reported as a failed run when the plan is filed and pending.
    mocks.moveTicket.mockRejectedValue(new Error("tracker down"));
    const ctx = makeCtx({ researchPlanMarkdown: "# Plan" });

    const result = await execute(makeNode("send_plan_approval"), {}, ctx);

    expect(result).toEqual({
      kind: "ended",
      output: { status: "awaiting_approval", approvalRequestId: "appr-9" },
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "AWT-1", err: "tracker down" }),
      "approval_park_failed",
    );
  });

  it("skips the mirror comment when mirrorComment is false", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Plan" });
    await execute(makeNode("send_plan_approval", { mirrorComment: false }), {}, ctx);
    expect(mocks.postComment).not.toHaveBeenCalled();
    expect(mocks.notifyForTicket).toHaveBeenCalledOnce();
  });
});
