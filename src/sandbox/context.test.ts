import { describe, it, expect } from "vitest";
import {
  assembleResearchPlanContext,
  assembleImplementationContext,
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

  it("renders attachments index when attachments are provided", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-3",
        title: "With files",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      branchName: "blazebot/test-3",
      attachments: [
        {
          filename: "mockup.png",
          originalFilename: "mockup.png",
          mimeType: "image/png",
          size: 348_192,
          content: Buffer.from([]),
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("/tmp/attachments/mockup.png");
    expect(result).toContain("image/png");

    const atIdx = result.indexOf("## Attachments");
    const descIdx = result.indexOf("## Description");
    expect(atIdx).toBeGreaterThan(-1);
    expect(descIdx).toBeGreaterThan(atIdx);
  });

  it("omits attachments section when list is empty or absent", () => {
    const withoutField = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
    });
    expect(withoutField).not.toContain("## Attachments");

    const withEmpty = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      attachments: [],
    });
    expect(withEmpty).not.toContain("## Attachments");
  });

  it("shows failed attachments in the index even when no bytes downloaded", () => {
    const result = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      attachments: [
        {
          filename: "spec.pdf",
          originalFilename: "spec.pdf",
          mimeType: "application/pdf",
          size: 0,
          failed: { reason: "HTTP 500", attempts: 3 },
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("⚠️");
    expect(result).toContain("spec.pdf");
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

  it("renders attachments index when attachments are provided", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-3",
        title: "With files",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      researchPlanMarkdown: "plan",
      attachments: [
        {
          filename: "mockup.png",
          originalFilename: "mockup.png",
          mimeType: "image/png",
          size: 348_192,
          content: Buffer.from([]),
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("/tmp/attachments/mockup.png");

    const atIdx = result.indexOf("## Attachments");
    const acIdx = result.indexOf("## Acceptance Criteria");
    expect(atIdx).toBeGreaterThan(-1);
    expect(acIdx).toBeGreaterThan(atIdx);
  });

  it("omits attachments section when list is empty or absent", () => {
    const withoutField = assembleImplementationContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
    });
    expect(withoutField).not.toContain("## Attachments");

    const withEmpty = assembleImplementationContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
      attachments: [],
    });
    expect(withEmpty).not.toContain("## Attachments");
  });

  it("shows failed attachments in the index even when no bytes downloaded", () => {
    const result = assembleImplementationContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
      attachments: [
        {
          filename: "spec.pdf",
          originalFilename: "spec.pdf",
          mimeType: "application/pdf",
          size: 0,
          failed: { reason: "HTTP 500", attempts: 3 },
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("⚠️");
    expect(result).toContain("spec.pdf");
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

  it("renders attachments index when attachments are provided", () => {
    const result = assembleReviewContext({
      ticket: {
        identifier: "TEST-3",
        title: "With files",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      researchPlanMarkdown: "plan",
      gitDiff: "diff",
      attachments: [
        {
          filename: "mockup.png",
          originalFilename: "mockup.png",
          mimeType: "image/png",
          size: 348_192,
          content: Buffer.from([]),
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("/tmp/attachments/mockup.png");

    const atIdx = result.indexOf("## Attachments");
    const acIdx = result.indexOf("## Acceptance Criteria");
    expect(atIdx).toBeGreaterThan(-1);
    expect(acIdx).toBeGreaterThan(atIdx);
  });

  it("omits attachments section when list is empty or absent", () => {
    const withoutField = assembleReviewContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
      gitDiff: "diff",
    });
    expect(withoutField).not.toContain("## Attachments");

    const withEmpty = assembleReviewContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
      gitDiff: "diff",
      attachments: [],
    });
    expect(withEmpty).not.toContain("## Attachments");
  });

  it("shows failed attachments in the index even when no bytes downloaded", () => {
    const result = assembleReviewContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
      gitDiff: "diff",
      attachments: [
        {
          filename: "spec.pdf",
          originalFilename: "spec.pdf",
          mimeType: "application/pdf",
          size: 0,
          failed: { reason: "HTTP 500", attempts: 3 },
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("⚠️");
    expect(result).toContain("spec.pdf");
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
