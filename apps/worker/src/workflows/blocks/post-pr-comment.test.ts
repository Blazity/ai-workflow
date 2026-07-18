import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRepositoryVCS: vi.fn(),
}));

vi.mock("../../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

import type { WorkspacePublicationResult } from "../workspace-publication.js";
import { execute, paramsSchema } from "./post-pr-comment.js";
import { makeCtx, makeNode, makePrPayload } from "./test-support.js";

function publication(): WorkspacePublicationResult {
  return {
    status: "published",
    attemptId: "attempt-1",
    repositories: [],
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
  });

  it("comments only the primary PR by default", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

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
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

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
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

    const result = await execute(
      makeNode("post_pr_comment", { body: "LGTM", target: "all" }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(postPRComment).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("next");
    if (result.kind === "next") {
      expect(result.output.comments).toHaveLength(2);
    }
  });

  it("falls back to the pr_trigger entry payload", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: "https://pr/comment" });
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

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

  it("returns failed with partial comments when one target errors", async () => {
    const postPRComment = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://pr/comment" })
      .mockRejectedValueOnce(new Error("gitlab down"));
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

    const result = await execute(
      makeNode("post_pr_comment", { body: "LGTM", target: "all" }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("gitlab down");
      expect(result.output.comments).toEqual([
        { provider: "github", repoPath: "acme/api", prId: 7, url: "https://pr/comment" },
      ]);
    }
  });

  it("fails when no pull request is in scope", async () => {
    const result = await execute(makeNode("post_pr_comment", { body: "hi" }), {}, makeCtx());
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("no pull request in scope");
  });
});
