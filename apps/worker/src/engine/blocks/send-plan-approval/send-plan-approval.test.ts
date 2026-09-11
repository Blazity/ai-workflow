import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertActiveRunOwner: vi.fn(),
  createApprovalRequest: vi.fn(),
  postComment: vi.fn(),
  notifyForTicket: vi.fn(),
  moveTicket: vi.fn(),
  updateLabels: vi.fn(),
  updateTicketLabels: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../infra/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../../services/run-lifecycle/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
  assertConnectedActiveRunOwner: (...args: any[]) =>
    mocks.assertActiveRunOwner(...args),
}));
vi.mock("../../../db/repositories/approvals.js", () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  createConnectedApprovalRequest: mocks.createApprovalRequest,
}));
vi.mock("../../../services/vcs/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: {
      postComment: mocks.postComment,
      moveTicket: mocks.moveTicket,
      updateLabels: mocks.updateLabels,
    },
    messaging: { notifyForTicket: mocks.notifyForTicket },
  }),
}));
vi.mock("../../../services/tickets/ticket-transition.js", () => ({
  moveTicketForRun: (...args: any[]) => mocks.moveTicket(...args),
  moveConnectedTicketForRun: (...args: any[]) => mocks.moveTicket(...args),
}));
vi.mock("../../../services/tickets/ticket-label-mutation.js", () => ({
  updateTicketLabelsForRun: (...args: any[]) =>
    mocks.updateTicketLabels(...args),
  updateConnectedTicketLabelsForRun: (...args: any[]) =>
    mocks.updateTicketLabels(...args),
}));

import { execute } from "./execute.js";
import { manifest } from "./manifest.js";
import { AWAITING_APPROVAL_LABEL } from "../../../services/tickets/labels.js";
import { makeCtx, makeNode, runControlErrorCases } from "../support/test-support.js";

describe("send_plan_approval paramsSchema", () => {
  it("defaults mirrorComment to true and rejects the retired planFromStep param", () => {
    expect(manifest.paramsSchema.parse({})).toEqual({ mirrorComment: true });
    expect(manifest.paramsSchema.safeParse({ mirrorComment: false }).success).toBe(true);
    expect(manifest.paramsSchema.safeParse({ planFromStep: "plan" }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("send_plan_approval execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
    mocks.createApprovalRequest.mockResolvedValue({ id: "appr-9" });
    mocks.postComment.mockResolvedValue(null);
    mocks.notifyForTicket.mockResolvedValue(undefined);
    mocks.moveTicket.mockResolvedValue(undefined);
    mocks.updateLabels.mockResolvedValue(undefined);
    mocks.updateTicketLabels.mockResolvedValue(undefined);
  });

  it("fails when no plan is available", async () => {
    const result = await execute(
      makeNode("send_plan_approval"),
      {},
      makeCtx({ researchPlanMarkdown: "" }),
    );
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("no plan available");
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  it("fails when the run has no stored definition", async () => {
    const result = await execute(
      makeNode("send_plan_approval"),
      {},
      makeCtx({ researchPlanMarkdown: "# Plan", definitionId: null }),
    );
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("approval requires a stored definition");
  });

  it("stores the plan, mirrors a comment, notifies, parks the ticket, and ends while retaining ownership", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Research plan" });
    const result = await execute(makeNode("send_plan_approval"), {}, ctx);

    expect(mocks.createApprovalRequest).toHaveBeenCalledWith({
      ticketKey: "AWT-1",
      definitionId: 1,
      definitionVersion: 1,
      runId: "run-1",
      plan: { markdown: "# Research plan" },
      assumptions: null,
      repositoryScope: null,
    });
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      "Plan awaiting approval in the dashboard.",
    );
    expect(mocks.notifyForTicket).toHaveBeenCalledWith("AWT-1", { kind: "plan_approval_requested" });
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledTimes(2);
    expect(mocks.assertActiveRunOwner).toHaveBeenNthCalledWith(
      1,
      { subjectKey: "ticket:jira:AWT-1", ownerToken: "owner:test", runId: "run-1" },
    );
    expect(mocks.assertActiveRunOwner).toHaveBeenNthCalledWith(
      2,
      { subjectKey: "ticket:jira:AWT-1", ownerToken: "owner:test", runId: "run-1" },
    );
    // Parked out of the AI column with an awaiting-approval label so the cron
    // poll stops re-dispatching it; label add precedes the move, mirroring
    // clarification. The workflow's terminal finally releases ownership.
    expect(mocks.updateTicketLabels).toHaveBeenCalledWith({
      issueTracker: expect.anything(),
      ticketKey: "AWT-1",
      owner: {
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner:test",
        runId: "run-1",
      },
      requiredOwnerState: "bound",
      changes: { add: [AWAITING_APPROVAL_LABEL] },
    });
    expect(mocks.updateLabels).not.toHaveBeenCalled();
    expect(mocks.moveTicket).toHaveBeenCalledWith({
      issueTracker: expect.anything(),
      ticketKey: "AWT-1",
      target: "Backlog",
      owner: {
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner:test",
        runId: "run-1",
      },
    });
    expect(result).toEqual({
      kind: "ended",
      output: { status: "awaiting_approval", approvalRequestId: "appr-9" },
    });
  });

  it("pins the run's current definition version onto the request", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Plan", definitionId: 3, definitionVersion: 5 });
    await execute(makeNode("send_plan_approval"), {}, ctx);
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ definitionId: 3, definitionVersion: 5 }),
    );
  });

  it("stores the exact trusted read/write repository scope with the plan", async () => {
    const ctx = makeCtx({
      researchPlanMarkdown: "# Plan",
      workspaceManifest: {
        version: 2,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            slug: "github__acme__api",
            localPath: "/vercel/sandbox/repos/github__acme__api",
            defaultBranch: "main",
            branchName: "blazebot/awt-1",
            selectedRationale: "implementation target",
            access: "write",
            researchBaseSha: "base-sha",
            expectedRemoteSha: "base-sha",
            preAgentSha: "base-sha",
          },
        ],
      },
    });

    await execute(makeNode("send_plan_approval"), {}, ctx);

    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryScope: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/api",
              defaultBranch: "main",
              researchBranch: "blazebot/awt-1",
              researchBaseSha: "base-sha",
              access: "write",
              rationale: "implementation target",
            },
          ],
        },
      }),
    );
  });

  // IM-3: an approval-gated planning run does not promote, so the manifest is
  // all-read. The research write set carries which repos the plan will change;
  // the persisted scope must mark exactly those as write (against the default
  // branch and its clone baseline) so the approved run promotes them.
  it("marks the research write set as write even on an all-read manifest", async () => {
    const ctx = makeCtx({
      researchPlanMarkdown: "# Plan",
      researchWriteRepositories: [
        { provider: "github", repoPath: "acme/api", rationale: "plan changes api" },
      ],
      workspaceManifest: {
        version: 2,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            slug: "github__acme__api",
            localPath: "/vercel/sandbox/repos/github__acme__api",
            defaultBranch: "main",
            branchName: "main",
            selectedRationale: "implementation target",
            access: "read",
            researchBaseSha: "base-sha",
          },
          {
            provider: "gitlab",
            repoPath: "acme/contracts",
            slug: "gitlab__acme__contracts",
            localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
            defaultBranch: "main",
            branchName: "main",
            selectedRationale: "read dependency",
            access: "read",
            researchBaseSha: "contracts-sha",
          },
        ],
      },
    });

    await execute(makeNode("send_plan_approval"), {}, ctx);

    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryScope: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/api",
              defaultBranch: "main",
              researchBranch: "main",
              researchBaseSha: "base-sha",
              access: "write",
              rationale: "implementation target",
            },
            {
              provider: "gitlab",
              repoPath: "acme/contracts",
              defaultBranch: "main",
              researchBranch: "main",
              researchBaseSha: "contracts-sha",
              access: "read",
              rationale: "read dependency",
            },
          ],
        },
      }),
    );
  });

  it("prefers bound plan and string assumptions over the compatibility research plan", async () => {
    const ctx = makeCtx({ researchPlanMarkdown: "# Research plan" });
    await execute(makeNode("send_plan_approval"), {}, ctx, {
      plan: "# Step plan",
      assumptions: ["db is seeded", 3],
    });
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
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

  it.each(runControlErrorCases())(
    "rethrows %s from approval provider boundaries",
    async (_label, error) => {
      mocks.assertActiveRunOwner.mockRejectedValue(error);
      const ctx = makeCtx({ researchPlanMarkdown: "# Plan" });

      await expect(execute(makeNode("send_plan_approval"), {}, ctx)).rejects.toBe(error);

      expect(mocks.assertActiveRunOwner).toHaveBeenCalledOnce();
      expect(mocks.postComment).not.toHaveBeenCalled();
      expect(mocks.notifyForTicket).not.toHaveBeenCalled();
      expect(mocks.updateLabels).not.toHaveBeenCalled();
    },
  );
});
