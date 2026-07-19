import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertActiveRunOwner: vi.fn(),
  postComment: vi.fn(),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
}));
vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: { postComment: mocks.postComment } }),
}));

import { execute, paramsSchema } from "./post-ticket-comment.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  runControlErrorCases,
} from "./test-support.js";

describe("post_ticket_comment paramsSchema", () => {
  it("allows a binding-only body and enforces the static-body limit", () => {
    expect(paramsSchema.safeParse({ body: "hello" }).success).toBe(true);
    expect(paramsSchema.safeParse({ body: "" }).success).toBe(true);
    expect(paramsSchema.safeParse({ body: "x".repeat(8001) }).success).toBe(false);
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ body: "hi", extra: 1 }).success).toBe(false);
  });
});

describe("post_ticket_comment execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  });

  it("posts the body on the ticket and returns the comment url", async () => {
    mocks.postComment.mockResolvedValue("https://jira/browse/AWT-1?focusedCommentId=9");

    const result = await execute(
      makeNode("post_ticket_comment", { body: "Done." }),
      {},
      makeCtx(),
    );

    expect(mocks.postComment).toHaveBeenCalledWith("AWT-1", "Done.");
    expect(mocks.assertActiveRunOwner).toHaveBeenCalledWith(
      { kind: "db" },
      { subjectKey: "ticket:jira:AWT-1", ownerToken: "owner:test", runId: "run-1" },
    );
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        commentUrl: "https://jira/browse/AWT-1?focusedCommentId=9",
      },
    });
  });

  it("prefers a resolved body over the static param", async () => {
    mocks.postComment.mockResolvedValue(null);

    await execute(
      makeNode("post_ticket_comment", { body: "Static" }),
      {},
      makeCtx(),
      { body: " Bound " },
    );

    expect(mocks.postComment).toHaveBeenCalledWith("AWT-1", "Bound");
  });

  it("fails when the body param is missing", async () => {
    const result = await execute(makeNode("post_ticket_comment"), {}, makeCtx());
    expect(result.kind).toBe("failed");
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("accepts a null comment URL when the tracker has no deep link", async () => {
    mocks.postComment.mockResolvedValue(null);

    const result = await execute(
      makeNode("post_ticket_comment", { body: "Done." }),
      {},
      makeCtx(),
    );

    expect(result).toEqual({ kind: "next", output: { status: "ok", commentUrl: null } });
    expectOutputConformsToRegistry("post_ticket_comment", result.output);
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

  it.each(runControlErrorCases())(
    "rethrows %s before posting",
    async (_label, controlError) => {
      mocks.assertActiveRunOwner.mockRejectedValue(controlError);

      await expect(
        execute(
          makeNode("post_ticket_comment", { body: "Done." }),
          {},
          makeCtx(),
        ),
      ).rejects.toBe(controlError);

      expect(mocks.postComment).not.toHaveBeenCalled();
    },
  );
});
