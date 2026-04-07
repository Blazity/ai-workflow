import { describe, it, expect } from "vitest";
import {
  assembleResearchPlanContext,
  assembleImplementationContext,
  assembleImplementationRetryContext,
  assembleReviewContext,
  formatCheckResults,
} from "./context.js";

describe("assembleResearchPlanContext", () => {
  it("assembles context for new ticket (no PR feedback)", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are a research agent...",
      branchName: "blazebot/test-1",
    });

    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-1");
    expect(result).toContain("## Branch");
    expect(result).toContain("blazebot/test-1");
    expect(result).toContain("You are a research agent...");
    expect(result).not.toContain("## PR Review Feedback");
  });

  it("assembles context with PR feedback for review-fix scenario", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-2",
        title: "Fix auth",
        description: "Fix auth module",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "prompt",
      branchName: "blazebot/test-2",
      prComments: [
        { author: "Bob", body: "Fix the null check", liked: false },
      ],
      checkResults: [
        { name: "test", status: "completed", conclusion: "failure", logs: "FAIL" },
      ],
      hasConflicts: true,
    });

    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Fix the null check");
    expect(result).toContain("## CI/CD Check Results");
    expect(result).toContain("### Failed: test");
    expect(result).toContain("## Merge Conflicts");
  });
});

describe("assembleImplementationContext (new)", () => {
  it("assembles context with research plan markdown", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are an implementation agent...",
      researchPlanMarkdown: "# Plan\n1. Create LoginForm component\n2. Add route handler",
    });

    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-1");
    expect(result).toContain("## Research & Plan");
    expect(result).toContain("# Plan");
    expect(result).toContain("Create LoginForm component");
    expect(result).toContain("You are an implementation agent...");
  });
});

describe("assembleImplementationRetryContext", () => {
  it("includes plan and review feedback", () => {
    const result = assembleImplementationRetryContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "prompt",
      researchPlanMarkdown: "# Plan\n1. Create LoginForm",
      reviewFeedback: {
        result: "changes_requested",
        feedback: "Missing error handling",
        issues: [
          { file: "src/LoginForm.tsx", description: "No null check", severity: "critical" },
        ],
      },
    });

    expect(result).toContain("## Research & Plan");
    expect(result).toContain("Create LoginForm");
    expect(result).toContain("## Review Feedback");
    expect(result).toContain("Missing error handling");
    expect(result).toContain("src/LoginForm.tsx");
    expect(result).toContain("No null check");
    expect(result).toContain("critical");
  });
});

describe("assembleReviewContext", () => {
  it("includes plan and git diff", () => {
    const result = assembleReviewContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are a review agent...",
      researchPlanMarkdown: "# Plan\n1. Create LoginForm",
      gitDiff: "diff --git a/src/LoginForm.tsx b/src/LoginForm.tsx\n+export function LoginForm() {}",
    });

    expect(result).toContain("## Research & Plan");
    expect(result).toContain("## Git Diff");
    expect(result).toContain("+export function LoginForm()");
    expect(result).toContain("You are a review agent...");
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
