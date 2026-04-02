import { describe, it, expect } from "vitest";
import { assembleImplementationContext, assembleFixingFeedbackContext, formatCheckResults } from "./context.js";

describe("assembleImplementationContext", () => {
  it("assembles requirements.md for implementation", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-1",
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
    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-1");
    expect(result.indexOf("## Ticket ID")).toBeLessThan(result.indexOf("## Ticket\n"));
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
        identifier: "TEST-2",
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
      checkResults: [],
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-2");
    expect(result.indexOf("## Ticket ID")).toBeLessThan(result.indexOf("## Ticket\n"));
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Fix the typo on line 5");
    expect(result).toContain("## CI/CD Check Results");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("You are a review-fix agent...");
  });

  it("renders line-coupled comments with file path and line range", () => {
    const result = assembleFixingFeedbackContext({
      ticket: {
        identifier: "TEST-3",
        title: "Fix auth",
        description: "Fix auth module",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "prompt",
      prComments: [
        { author: "Bob", body: "Use a constant", liked: false, filePath: "src/lib/auth.ts", startLine: 42, endLine: 45 },
        { author: "Alice", body: "Looks good but add error handling", liked: true, filePath: "src/components/Form.tsx", startLine: 12, endLine: 12 },
        { author: "Charlie", body: "Overall looks good", liked: false },
      ],
      hasConflicts: false,
      checkResults: [],
    });

    expect(result).toContain("### src/lib/auth.ts (lines 42-45)");
    expect(result).toContain("Bob: Use a constant");
    expect(result).toContain("### src/components/Form.tsx (line 12)");
    expect(result).toContain("Alice (liked): Looks good but add error handling");
    expect(result).toContain("Charlie: Overall looks good");
    // Line-coupled comments should appear before general comments
    expect(result.indexOf("src/components/Form.tsx")).toBeLessThan(result.indexOf("Charlie: Overall looks good"));
  });

  it("includes CI/CD check results section between PR feedback and merge conflicts", () => {
    const result = assembleFixingFeedbackContext({
      ticket: {
        identifier: "TEST-4",
        title: "Fix tests",
        description: "Fix failing tests",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "prompt",
      prComments: [],
      hasConflicts: false,
      checkResults: [
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure", logs: "FAIL src/app.test.ts\nExpected true, got false" },
      ],
    });

    const prFeedbackIdx = result.indexOf("## PR Review Feedback");
    const ciIdx = result.indexOf("## CI/CD Check Results");
    const mergeIdx = result.indexOf("## Merge Conflicts");
    expect(ciIdx).toBeGreaterThan(prFeedbackIdx);
    expect(ciIdx).toBeLessThan(mergeIdx);
    expect(result).toContain("Passed: lint");
    expect(result).toContain("### Failed: test");
    expect(result).toContain("FAIL src/app.test.ts");
  });
});

describe("formatCheckResults", () => {
  it("returns message when no checks found", () => {
    expect(formatCheckResults([])).toBe("No CI/CD checks found.");
  });

  it("returns all-passed message when all succeed", () => {
    const result = formatCheckResults([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "build", status: "completed", conclusion: "success" },
    ]);
    expect(result).toBe("All CI/CD checks passed.");
  });

  it("shows passed and failed checks with logs", () => {
    const result = formatCheckResults([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure", logs: "Error: test failed" },
      { name: "e2e", status: "completed", conclusion: "failure", logs: "Timeout on login page" },
    ]);
    expect(result).toContain("Passed: lint, build");
    expect(result).toContain("### Failed: test\nError: test failed");
    expect(result).toContain("### Failed: e2e\nTimeout on login page");
  });

  it("shows conclusion when logs are not available", () => {
    const result = formatCheckResults([
      { name: "external-ci", status: "completed", conclusion: "failure" },
    ]);
    expect(result).toContain("### Failed: external-ci");
    expect(result).toContain("Conclusion: failure");
  });
});
