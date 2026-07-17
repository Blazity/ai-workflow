import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postComment: vi.fn(),
}));

vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: { postComment: mocks.postComment } }),
}));

import { execute, paramsSchema } from "./post-ticket-comment.js";
import { makeCtx, makeNode } from "./test-support.js";

describe("post_ticket_comment paramsSchema", () => {
  it("requires a non-empty body within limits", () => {
    expect(paramsSchema.safeParse({ body: "hello" }).success).toBe(true);
    expect(paramsSchema.safeParse({ body: "" }).success).toBe(false);
    expect(paramsSchema.safeParse({ body: "x".repeat(8001) }).success).toBe(false);
    expect(paramsSchema.safeParse({}).success).toBe(false);
    expect(paramsSchema.safeParse({ body: "hi", extra: 1 }).success).toBe(false);
  });
});

describe("post_ticket_comment execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the body on the ticket and returns the comment url", async () => {
    mocks.postComment.mockResolvedValue("https://jira/browse/AWT-1?focusedCommentId=9");

    const result = await execute(
      makeNode("post_ticket_comment", { body: "Done." }),
      {},
      makeCtx(),
    );

    expect(mocks.postComment).toHaveBeenCalledWith("AWT-1", "Done.");
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        commentUrl: "https://jira/browse/AWT-1?focusedCommentId=9",
      },
    });
  });

  it("fails when the body param is missing", async () => {
    const result = await execute(makeNode("post_ticket_comment"), {}, makeCtx());
    expect(result.kind).toBe("failed");
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("maps tracker errors to a failed result", async () => {
    mocks.postComment.mockRejectedValue(new Error("jira down"));

    const result = await execute(
      makeNode("post_ticket_comment", { body: "Done." }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("jira down");
  });
});
