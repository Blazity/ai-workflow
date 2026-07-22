import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertActiveRunOwner: vi.fn(),
  createRepositoryVCS: vi.fn(),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
}));
vi.mock("../../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

import type { WorkspacePublicationResult } from "../workspace-publication.js";
import { execute, paramsSchema } from "./post-pr-comment.js";
import { makeCtx, makeNode, makePrPayload, runControlErrorCases } from "./test-support.js";

function publication(): WorkspacePublicationResult {
  return {
    status: "published",
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        branchName: "blazebot/awt-1",
        defaultBranch: "main",
        expectedHead: "api-before",
        pushedHead: "abc123",
      },
      {
        provider: "gitlab",
        repoPath: "acme/web",
        branchName: "blazebot/awt-1",
        defaultBranch: "main",
        expectedHead: "web-before",
        pushedHead: "def456",
      },
    ],
    pushResult: { pushed: true, repositories: [] },
    prs: [
      {
        provider: "github",
        repoPath: "acme/api",
        id: 7,
        url: "https://github.com/acme/api/pull/7",
        branch: "blazebot/awt-1",
        isNew: true,
      },
      {
        provider: "gitlab",
        repoPath: "acme/web",
        id: 9,
        url: "https://gitlab.com/acme/web/-/merge_requests/9",
        branch: "blazebot/awt-1",
        isNew: true,
      },
    ],
  };
}

function mockFreshVcs(postPRComment: ReturnType<typeof vi.fn>) {
  mocks.createRepositoryVCS.mockImplementation(({ repoPath }: { repoPath: string }) => ({
    getPRHead: vi.fn().mockResolvedValue({
      headSha: repoPath === "acme/web" ? "def456" : "abc123",
      baseRef: "main",
      state: "open",
    }),
    postPRComment,
  }));
}

describe("post_pr_comment paramsSchema", () => {
  it("allows a binding-only body, defaults target to primary, and rejects unknown keys", () => {
    const parsed = paramsSchema.safeParse({ body: "hi" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.target).toBe("primary");
    expect(paramsSchema.safeParse({ body: "" }).success).toBe(true);
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ body: "x".repeat(16001) }).success).toBe(false);
    expect(paramsSchema.safeParse({ body: "hi", target: "some" }).success).toBe(false);
    expect(paramsSchema.safeParse({ body: "hi", extra: 1 }).success).toBe(false);
  });
});

describe("post_pr_comment execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  });

  it("comments only the primary PR by default", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
    mockFreshVcs(postPRComment);

    const result = await execute(
      makeNode("post_pr_comment", { body: "LGTM" }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(postPRComment).toHaveBeenCalledTimes(1);
    expect(postPRComment).toHaveBeenCalledWith(7, "LGTM");
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        comments: [
          { provider: "github", repoPath: "acme/api", prId: 7, url: "https://pr/comment" },
        ],
      },
    });
  });

  it("prefers a resolved body over the static param", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: null });
    mockFreshVcs(postPRComment);

    await execute(
      makeNode("post_pr_comment", { body: "Static" }),
      {},
      makeCtx({ publication: publication() }),
      { body: " Bound " },
    );

    expect(postPRComment).toHaveBeenCalledWith(7, "Bound");
  });

  it("comments every PR when target is all", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: null });
    mockFreshVcs(postPRComment);

    const result = await execute(
      makeNode("post_pr_comment", { body: "LGTM", target: "all" }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(postPRComment).toHaveBeenCalledTimes(2);
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledTimes(2);
    expect(mocks.assertActiveRunOwner).toHaveBeenNthCalledWith(
      1,
      { kind: "db" },
      { subjectKey: "ticket:jira:AWT-1", ownerToken: "owner:test", runId: "run-1" },
    );
    expect(mocks.assertActiveRunOwner).toHaveBeenNthCalledWith(
      2,
      { kind: "db" },
      { subjectKey: "ticket:jira:AWT-1", ownerToken: "owner:test", runId: "run-1" },
    );
    expect(result.kind).toBe("next");
    if (result.kind === "next") {
      expect(result.output!.comments).toHaveLength(2);
    }
  });

  it("falls back to the pr_trigger entry payload", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
    mockFreshVcs(postPRComment);

    const result = await execute(
      makeNode("post_pr_comment", { body: "checks are red" }),
      {},
      makeCtx({
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_checks_failed",
          subjectKey: "ticket:jira:AWT-1",
          ticketKey: "AWT-1",
          ownerToken: "owner:test",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr: makePrPayload(),
        },
      }),
    );

    expect(mocks.createRepositoryVCS).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    expect(postPRComment).toHaveBeenCalledWith(7, "checks are red");
    expect(result.kind).toBe("next");
  });

  it.each([
    {
      current: { headSha: "new-head", baseRef: "main", state: "open" as const },
      expectedReason: "new-head",
    },
    {
      current: { headSha: "abc123", baseRef: "release", state: "open" as const },
      expectedReason: "release",
    },
    {
      current: { headSha: "abc123", baseRef: "main", state: "closed" as const },
      expectedReason: "closed",
    },
  ])(
    "refuses stale trigger feedback before posting: $expectedReason",
    async ({ current, expectedReason }) => {
      const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
      mocks.createRepositoryVCS.mockReturnValue({
        getPRHead: vi.fn().mockResolvedValue(current),
        postPRComment,
      });

      const result = await execute(
        makeNode("post_pr_comment", { body: "review feedback" }),
        {},
        makeCtx({
          entry: {
            kind: "pr_trigger",
            triggerType: "trigger_pr_review",
            subjectKey: "pr:github:acme/api:7",
            ownerToken: "owner:test",
            definitionId: 1,
            definitionVersion: 1,
            scope: "any",
            pr: makePrPayload(),
          },
        }),
      );

      expect(result.kind).toBe("execution_error");
      if (result.kind === "execution_error") expect(result.error.detail).toContain(expectedReason);
      expect(postPRComment).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      current: { headSha: "new-head", baseRef: "main", state: "open" as const },
      expectedReason: "new-head",
    },
    {
      current: { headSha: "abc123", baseRef: "release", state: "open" as const },
      expectedReason: "release",
    },
    {
      current: { headSha: "abc123", baseRef: "main", state: "closed" as const },
      expectedReason: "closed",
    },
  ])(
    "refuses stale publication feedback before posting: $expectedReason",
    async ({ current, expectedReason }) => {
      const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
      mocks.createRepositoryVCS.mockReturnValue({
        getPRHead: vi.fn().mockResolvedValue(current),
        postPRComment,
      });

      const result = await execute(
        makeNode("post_pr_comment", { body: "publication complete" }),
        {},
        makeCtx({ publication: publication() }),
      );

      expect(result.kind).toBe("execution_error");
      if (result.kind === "execution_error") expect(result.error.detail).toContain(expectedReason);
      expect(postPRComment).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact merged lifecycle for a merged trigger", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
    mocks.createRepositoryVCS.mockReturnValue({
      getPRHead: vi.fn().mockResolvedValue({
        headSha: "abc123",
        baseRef: "main",
        state: "merged",
      }),
      postPRComment,
    });

    const result = await execute(
      makeNode("post_pr_comment", { body: "merged" }),
      {},
      makeCtx({
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_merged",
          subjectKey: "pr:github:acme/api:7",
          ticketKey: "AWT-1",
          ownerToken: "owner:test",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr: makePrPayload(),
        },
      }),
    );

    expect(result.kind).toBe("next");
    expect(postPRComment).toHaveBeenCalledWith(7, "merged");
  });

  it("returns an execution error without publishing partial comments", async () => {
    const postPRComment = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://pr/comment" })
      .mockRejectedValueOnce(new Error("gitlab down"));
    mockFreshVcs(postPRComment);

    const result = await execute(
      makeNode("post_pr_comment", { body: "LGTM", target: "all" }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("gitlab down");
      expect(result.output).toBeUndefined();
    }
  });

  it("fails when no pull request is in scope", async () => {
    const result = await execute(makeNode("post_pr_comment", { body: "hi" }), {}, makeCtx());
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("no pull request in scope");
  });

  it.each(runControlErrorCases())(
    "rethrows %s and stops later comments",
    async (_label, controlError) => {
      const postPRComment = vi.fn().mockResolvedValue({ url: null });
      mockFreshVcs(postPRComment);
      mocks.assertActiveRunOwner
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(controlError);

      await expect(
        execute(
          makeNode("post_pr_comment", { body: "LGTM", target: "all" }),
          {},
          makeCtx({ publication: publication() }),
        ),
      ).rejects.toBe(controlError);

      expect(mocks.assertActiveRunOwner).toHaveBeenCalledTimes(2);
      expect(postPRComment).toHaveBeenCalledTimes(1);
    },
  );
});
