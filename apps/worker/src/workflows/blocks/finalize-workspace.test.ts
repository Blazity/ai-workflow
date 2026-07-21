import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ finalizeWorkspacePublication: vi.fn() }));

vi.mock("../workspace-publication.js", () => ({
  finalizeWorkspacePublication: mocks.finalizeWorkspacePublication,
}));

import type {
  WorkspaceManifest,
  WorkspaceRepositoryInput,
} from "../../sandbox/repo-workspace.js";
import { execute, paramsSchema } from "./finalize-workspace.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  makePrPayload,
  runControlErrorCases,
} from "./test-support.js";

const repo: WorkspaceRepositoryInput = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "selected",
};

const trustedManifest: WorkspaceManifest = {
  version: 1,
  repositories: [{
    ...repo,
    slug: "acme__api",
    localPath: "/vercel/sandbox",
    branchName: "blazebot/awt-1",
    expectedRemoteSha: "before",
    preAgentSha: "before",
  }],
};

const finalized = {
  status: "finalized" as const,
  repositories: [
    {
      provider: "github" as const,
      repoPath: "acme/api",
      branchName: "blazebot/awt-1",
      defaultBranch: "main",
      expectedHead: "before",
      pushedHead: "after",
    },
  ],
  prs: [] as [],
};

describe("finalize_workspace paramsSchema", () => {
  it("accepts empty params and rejects retired authoring params", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ legacyRequiredChecks: ["checks.with dots"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ requiredChecks: ["checks-1"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("finalize_workspace execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalizeWorkspacePublication.mockResolvedValue(finalized);
  });

  it("ignores unrelated prior step records", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      { "checks-1": { output: { status: "failed", ok: false } } },
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
    );
    expect(result.kind).toBe("next");
  });

  it("rejects any resolved check status that is not ok", async () => {
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
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("publishes when every resolved check status is ok", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      { "checks.lint": "ok", "checks.test": "ok" },
    );

    expect(result.kind).toBe("next");
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledOnce();
  });

  it("fails when no workspace is attached", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ sandboxId: null }),
    );
    expect(result.kind).toBe("failed");
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace has no manager-authored trusted manifest", async () => {
    const result = await execute(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ sandboxId: "sbx-1", workspaceManifest: null }),
    );

    expect(result).toEqual(expect.objectContaining({
      kind: "failed",
      reason: expect.stringContaining("trusted"),
    }));
    expect(mocks.finalizeWorkspacePublication).not.toHaveBeenCalled();
  });

  it("passes the manager-authored manifest as the publication authority", async () => {
    await execute(
      makeNode("finalize_workspace", {}, "finalize"),
      {},
      makeCtx({
        selectedRepositories: [repo],
        workspaceManifest: trustedManifest,
      }),
    );

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceManifest: trustedManifest }),
    );
  });

  it("pushes and emits finalized branch metadata", async () => {
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    });
    const result = await execute(makeNode("finalize_workspace", {}, "finalize"), {}, ctx);

    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith({
      runId: "run-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner:test",
      sandboxId: "sbx-1",
      ticketKey: "AWT-1",
      workspaceManifest: trustedManifest,
      clarifications: undefined,
      sourcePullRequest: undefined,
    });
    expect(ctx.publication).toEqual(finalized);
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "finalized",
        repositories: finalized.repositories,
      },
    });
    expectOutputConformsToRegistry("finalize_workspace", result.output);
  });

  it("passes the exact triggering PR/MR source head into publication", async () => {
    const pr = makePrPayload({ headSha: "trigger-head" });
    await execute(
      makeNode("finalize_workspace", {}, "finalize"),
      {},
      makeCtx({
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_review",
          subjectKey: "pr:github:acme/api#7",
          ticketKey: "AWT-1",
          ownerToken: "owner-1",
          scope: "workflow_owned",
          definitionId: 1,
          definitionVersion: 1,
          pr,
        },
        selectedRepositories: [repo],
        workspaceManifest: trustedManifest,
      }),
    );
    expect(mocks.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePullRequest: {
          provider: "github",
          repoPath: "acme/api",
          prId: 7,
          headSha: "trigger-head",
          baseRef: "main",
        },
      }),
    );
  });

  it("maps a failed durable publication to the push phase without PR side effects", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      reason: "lease rejected",
      repositories: [],
      prs: [],
    });
    const ctx = makeCtx({
      selectedRepositories: [repo],
      workspaceManifest: trustedManifest,
    });
    const result = await execute(makeNode("finalize_workspace"), {}, ctx);

    expect(result).toEqual({
      kind: "failed",
      output: { status: "failed" },
      reason: "lease rejected",
      phase: "push",
    });
  });

  it.each(runControlErrorCases())("rethrows %s from publication", async (_label, error) => {
    mocks.finalizeWorkspacePublication.mockRejectedValue(error);

    await expect(
      execute(
        makeNode("finalize_workspace"),
        {},
        makeCtx({ selectedRepositories: [repo], workspaceManifest: trustedManifest }),
      ),
    ).rejects.toBe(error);
  });
});
