import { describe, it, expect } from "vitest";
import { assembleImplementationContext, assembleFixingFeedbackContext } from "./context.js";

describe("assembleImplementationContext", () => {
  it("assembles requirements.md for implementation", () => {
    const result = assembleImplementationContext({
      ticket: {
        title: "Add login page",
        description: "Build a login page with OAuth",
        acceptanceCriteria: "- User can log in\n- User can log out",
        comments: [
          { author: "Alice", body: "Use OAuth2", createdAt: "2026-03-20T10:00:00Z" },
        ],
      },
      prompt: "You are an implementation agent...",
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("Add login page");
    expect(result).toContain("Build a login page with OAuth");
    expect(result).toContain("User can log in");
    expect(result).toContain("Alice: Use OAuth2");
    expect(result).toContain("You are an implementation agent...");
  });
});

describe("assembleFixingFeedbackContext", () => {
  it("assembles requirements.md for fixing feedback", () => {
    const result = assembleFixingFeedbackContext({
      ticket: {
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "You are a review-fix agent...",
      prComments: [
        { author: "Bob", body: "Fix the typo on line 5", liked: true },
      ],
      hasConflicts: true,
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Fix the typo on line 5");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("You are a review-fix agent...");
  });
});
