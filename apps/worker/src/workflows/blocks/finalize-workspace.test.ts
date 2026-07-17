import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publishWorkspaceChanges: vi.fn(),
  postComment: vi.fn(),
}));

vi.mock("../workspace-publication.js", () => ({
  publishWorkspaceChanges: mocks.publishWorkspaceChanges,
}));

vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: { postComment: mocks.postComment } }),
}));

import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import { execute, paramsSchema } from "./finalize-workspace.js";
import { expectOutputConformsToRegistry, makeCtx, makeNode } from "./test-support.js";

const repo: WorkspaceRepositoryInput = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "selected",
};

const publishedPr = {
  provider: "github" as const,
  repoPath: "acme/api",
  id: 7,
  url: "https://github.com/acme/api/pull/7",
  branch: "blazebot/awt-1",
  isNew: true,
};

describe("finalize_workspace paramsSchema", () => {
  it("accepts the execution-only legacy marker and rejects retired authoring params", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ legacyRequiredChecks: ["checks.with dots"] }).success).toBe(
      true,
    );
    expect(paramsSchema.safeParse({ requiredChecks: ["checks-1"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("finalize_workspace execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores unrelated prior step records", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "published",
      pushResult: { pushed: true, repositories: [] },
      prs: [publishedPr],
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      { "checks-1": { output: { status: "failed", ok: false } } },
      makeCtx({ selectedRepositories: [repo] }),
    );

    expect(result.kind).toBe("next");
    expect(mocks.publishWorkspaceChanges).toHaveBeenCalled();
  });

  it("preserves the legacy gate by rejecting any resolved check status that is not ok", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx(),
      { "checks.lint": "ok", "checks.test": "failed" },
    );

    expect(result).toEqual({
      kind: "failed",
      output: { status: "failed", unmetChecks: ["test"] },
      reason: "required checks not satisfied: test",
    });
    expectOutputConformsToRegistry("finalize_workspace", result.output);
    expect(mocks.publishWorkspaceChanges).not.toHaveBeenCalled();
  });

  it("publishes when every resolved check status is ok", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "published",
      pushResult: { pushed: true, repositories: [] },
      prs: [publishedPr],
    });

    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo] }),
      { "checks.lint": "ok", "checks.test": "ok" },
    );

    expect(result.kind).toBe("next");
    expect(mocks.publishWorkspaceChanges).toHaveBeenCalledOnce();
  });

  it("gates typed and unrepresentable legacy checks without duplicate failures", async () => {
    const result = await execute(
      makeNode("finalize_workspace", {
        legacyRequiredChecks: [
          "duplicate",
          "checks.with.dot",
          "checks space",
          "missing",
          "constructor",
          "duplicate",
        ],
      }),
      {
        duplicate: { output: { status: "failed" } },
        "checks.with.dot": { output: { status: "failed" } },
        "checks space": { output: { status: "ok" } },
      },
      makeCtx(),
      { "checks.typed": "failed", "checks.duplicate": "failed" },
    );

    expect(result).toEqual({
      kind: "failed",
      output: {
        status: "failed",
        unmetChecks: ["typed", "duplicate", "checks.with.dot", "missing", "constructor"],
      },
      reason:
        "required checks not satisfied: typed, duplicate, checks.with.dot, missing, constructor",
    });
    expect(mocks.publishWorkspaceChanges).not.toHaveBeenCalled();
  });

  it("fails when no workspace is attached", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ sandboxId: null }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("no workspace");
    expect(mocks.publishWorkspaceChanges).not.toHaveBeenCalled();
  });

  it("publishes, sets ctx.publication, comments PR links, and unregisters before PRs", async () => {
    mocks.publishWorkspaceChanges.mockImplementation(
      async (input: { beforeCreatePullRequests?: () => Promise<void> }) => {
        await input.beforeCreatePullRequests?.();
        return {
          status: "published",
          pushResult: { pushed: true, repositories: [] },
          prs: [publishedPr],
        };
      },
    );
    const ctx = makeCtx({ selectedRepositories: [repo] });

    const result = await execute(makeNode("finalize_workspace"), {}, ctx);

    expect(mocks.publishWorkspaceChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx-1",
        ticketKey: "AWT-1",
        branchName: "blazebot/awt-1",
        repositories: [repo],
        title: "Ticket title",
        agentKind: "claude",
        model: "claude-model",
      }),
    );
    expect(ctx.unregisterBeforePr).toHaveBeenCalledTimes(1);
    expect(ctx.publication?.status).toBe("published");
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      expect.stringContaining("Pull requests ready for review:"),
    );
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "published",
        prs: [
          {
            provider: "github",
            repoPath: "acme/api",
            id: 7,
            url: "https://github.com/acme/api/pull/7",
            isNew: true,
          },
        ],
      },
    });
  });

  it("does not comment when every PR already existed", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "published",
      pushResult: { pushed: true, repositories: [] },
      prs: [{ ...publishedPr, isNew: false }],
    });

    await execute(makeNode("finalize_workspace"), {}, makeCtx({ selectedRepositories: [repo] }));

    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("maps a failed publication to kind failed with the push phase", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "failed",
      reason: "push rejected",
      pushResult: { pushed: false, repositories: [] },
      prs: [publishedPr],
    });
    const ctx = makeCtx({ selectedRepositories: [repo] });

    const result = await execute(makeNode("finalize_workspace"), {}, ctx);

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("push rejected");
      expect(result.phase).toBe("push");
    }
    expect(ctx.publication?.status).toBe("failed");
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      expect.stringContaining("Pull requests created before publication failed:"),
    );
  });
});
