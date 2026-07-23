import { describe, expect, it } from "vitest";
import {
  appendReviewFeedbackComment,
  resolveReviewFeedbackInput,
} from "./review-feedback.js";

const ambient = {
  state: "changes_requested" as const,
  author: "Alice",
  body: "Please add coverage.",
};

describe("resolveReviewFeedbackInput", () => {
  it("prefers an explicit typed binding over legacy ambient feedback", () => {
    expect(
      resolveReviewFeedbackInput(
        {
          reviewFeedback: {
            state: "commented",
            author: "Bob",
            body: "Please rename this.",
          },
        },
        { ambient, allowAmbientFallback: true },
      ),
    ).toEqual({
      ok: true,
      source: "binding",
      value: {
        state: "commented",
        author: "Bob",
        body: "Please rename this.",
      },
    });
  });

  it("supports an explicit legacy ambient fallback and otherwise stays unbound", () => {
    expect(
      resolveReviewFeedbackInput({}, { ambient, allowAmbientFallback: true }),
    ).toEqual({ ok: true, source: "ambient", value: ambient });
    expect(resolveReviewFeedbackInput({}, { ambient })).toEqual({
      ok: true,
      source: null,
      value: undefined,
    });
  });

  it("rejects malformed or open explicit objects with a safe message", () => {
    const result = resolveReviewFeedbackInput({
      reviewFeedback: {
        ...ambient,
        state: "approved",
        token: "must-not-appear",
      },
    });
    expect(result).toEqual({
      ok: false,
      message:
        "The review feedback input must contain a valid state, author, and body.",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-appear");
  });
});

describe("appendReviewFeedbackComment", () => {
  it("does not duplicate exact or provider-prefixed review comments", () => {
    expect(
      appendReviewFeedbackComment(
        [
          {
            author: "alice",
            body: "[Review: changes requested] Please add coverage.",
            liked: false,
          },
        ],
        ambient,
      ),
    ).toHaveLength(1);
  });

  it("appends distinct feedback as a normal PR comment", () => {
    expect(
      appendReviewFeedbackComment(
        [{ author: "Bob", body: "Different comment.", liked: false }],
        ambient,
      ),
    ).toEqual([
      { author: "Bob", body: "Different comment.", liked: false },
      {
        author: "Alice",
        body: "Please add coverage.",
        liked: false,
      },
    ]);
  });
});
