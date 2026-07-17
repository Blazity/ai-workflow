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
  it("accepts empty params and a requiredChecks array", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ requiredChecks: ["checks-1"] }).success).toBe(true);
    expect(paramsSchema.safeParse({ requiredChecks: [""] }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("finalize_workspace execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails before pushing when a required check is not ok", async () => {
    const result = await execute(
      makeNode("finalize_workspace", { requiredChecks: ["checks-1", "missing"] }),
      { "checks-1": { output: { status: "ok", ok: false } } },
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("missing");
      expect(result.output.unmetChecks).toEqual(["missing"]);
      expectOutputConformsToRegistry("finalize_workspace", result.output);
    }
    expect(mocks.publishWorkspaceChanges).not.toHaveBeenCalled();
  });

  it("passes the gate when required check outputs report status ok", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "published",
      pushResult: { pushed: true, repositories: [] },
      prs: [publishedPr],
    });

    const result = await execute(
      makeNode("finalize_workspace", { requiredChecks: ["checks-1"] }),
      { "checks-1": { output: { status: "ok", ok: true } } },
      makeCtx({ selectedRepositories: [repo] }),
    );

    expect(result.kind).toBe("next");
    expect(mocks.publishWorkspaceChanges).toHaveBeenCalled();
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
