import { describe, it, expect } from "vitest";
import {
  assembleResearchPlanContext,
  assembleImplementationContext,
  assembleReviewContext,
  assembleFixContext,
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

  it("groups PR feedback, checks, and merge conflicts by selected repository", () => {
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
      repositoryContexts: [
        {
          repository: {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch for this ticket",
          },
          prComments: [{ author: "Bob", body: "Fix the null check", liked: false }],
          checkResults: [{ name: "test", status: "completed", conclusion: "failure", logs: "FAIL" }],
          hasConflicts: true,
        },
        {
          repository: {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
          prComments: [{ author: "Alice", body: "Button copy is wrong", liked: false }],
          checkResults: [],
          hasConflicts: false,
        },
      ],
    });

    expect(result).toContain("## PR Review Feedback: github:acme/api");
    expect(result).toContain("Fix the null check");
    expect(result).toContain("## CI/CD Check Results: github:acme/api");
    expect(result).toContain("### Failed: test");
    expect(result).toContain("## Merge Conflicts: github:acme/api");
    expect(result).toContain("## PR Review Feedback: github:acme/web");
    expect(result).toContain("Button copy is wrong");
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

  it("renders research pre-sandbox additions only when provided", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-4",
        title: "Research note",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      branchName: "blazebot/test-4",
      preSandboxAdditions: [
        {
          target: ["research"],
          title: "Ticket Complexity Check",
          content: "This ticket should be researched before implementation.",
        },
      ],
    });
    expect(result).toContain("## Pre-Sandbox: Ticket Complexity Check");
    expect(result).toContain("This information was produced before sandbox creation.");
    expect(result).toContain("This ticket should be researched before implementation.");

    const withoutAdditions = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
    });
    expect(withoutAdditions).not.toContain("## Pre-Sandbox");
  });

  it("renders selected repositories with Run Workspace paths", () => {
    const result = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
        },
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "ticket mentions web",
        },
      ],
    });

    expect(result).toContain("## Selected Repositories");
    expect(result).toContain("acme/api");
    expect(result).toContain("`github:acme/api` at `/vercel/sandbox`");
    expect(result).toContain("`github:acme/web` at `/vercel/sandbox/repos/github__acme__web`");
    expect(result).toContain("Edit only these Run Workspace repositories");
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

  it("surfaces PR review feedback when re-run against an existing PR", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-9",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are an implementation agent...",
      researchPlanMarkdown: "plan",
      repositoryContexts: [
        {
          repository: {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch for this ticket",
          },
          prComments: [
            { author: "Bob", body: "[Review: changes requested] fix the null check", liked: false },
          ],
          checkResults: [],
          hasConflicts: false,
        },
      ],
    });

    expect(result).toContain("## PR Review Feedback: github:acme/api");
    expect(result).toContain("fix the null check");
    // Remediation framing leads so the agent targets the review, not the ticket.
    expect(result).toContain("## Existing pull request — address this review feedback");
  });

  it("omits PR review feedback when repositoryContexts are absent or empty", () => {
    const base = {
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
    };
    expect(assembleImplementationContext(base)).not.toContain("## PR Review Feedback");
    expect(
      assembleImplementationContext({
        ...base,
        repositoryContexts: [
          {
            repository: {
              provider: "github",
              repoPath: "acme/api",
              defaultBranch: "main",
              selectedRationale: "workflow-owned branch for this ticket",
            },
            prComments: [],
            checkResults: [],
            hasConflicts: false,
          },
        ],
      }),
    ).not.toContain("## PR Review Feedback");
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

  it("renders implementation pre-sandbox additions only when provided", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-4",
        title: "Implementation note",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      researchPlanMarkdown: "plan",
      preSandboxAdditions: [
        {
          target: ["implementation"],
          title: "Dependency Check",
          content: "Install dependencies before coding.",
        },
      ],
    });
    expect(result).toContain("## Pre-Sandbox: Dependency Check");
    expect(result).toContain("This information was produced before sandbox creation.");
    expect(result).toContain("Install dependencies before coding.");

    const withoutAdditions = assembleImplementationContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
    });
    expect(withoutAdditions).not.toContain("## Pre-Sandbox");
  });
});

describe("assembleReviewContext", () => {
  it("includes plan and prompt", () => {
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
    });

    expect(result).toContain("## Research & Plan");
    expect(result).toContain("1. Create LoginForm");
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
    });
    expect(withoutField).not.toContain("## Attachments");

    const withEmpty = assembleReviewContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
      attachments: [],
    });
    expect(withEmpty).not.toContain("## Attachments");
  });

  it("shows failed attachments in the index even when no bytes downloaded", () => {
    const result = assembleReviewContext({
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

  it("renders review pre-sandbox additions only when provided", () => {
    const result = assembleReviewContext({
      ticket: {
        identifier: "TEST-4",
        title: "Review note",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      researchPlanMarkdown: "plan",
      preSandboxAdditions: [
        {
          target: ["review"],
          title: "Review Checklist",
          content: "Verify pre-sandbox findings before approving.",
        },
      ],
    });
    expect(result).toContain("## Pre-Sandbox: Review Checklist");
    expect(result).toContain("This information was produced before sandbox creation.");
    expect(result).toContain("Verify pre-sandbox findings before approving.");

    const withoutAdditions = assembleReviewContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
    });
    expect(withoutAdditions).not.toContain("## Pre-Sandbox");
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

describe("assembleFixContext", () => {
  const ticket = {
    identifier: "TEST-9",
    title: "Fix the thing",
    description: "d",
    acceptanceCriteria: "It works",
    comments: [],
  };

  it("assembles review feedback, failed checks, conflicts, instructions, and repos", () => {
    const result = assembleFixContext({
      ticket,
      prComments: [{ author: "Bob", body: "Handle the null case", liked: false }],
      failedChecks: [
        { name: "test", status: "completed", conclusion: "failure", logs: "boom" },
      ],
      conflictNotes: "Resolve markers in api/",
      instructions: "Address every review comment before pushing.",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "target repo",
        },
      ],
    });

    expect(result).toContain("# Fix Requirements");
    expect(result).toContain("TEST-9");
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Handle the null case");
    expect(result).toContain("## CI/CD Check Results");
    expect(result).toContain("### Failed: test");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("Resolve markers in api/");
    expect(result).toContain("## Selected Repositories");
    expect(result).toContain("acme/api");
    expect(result).toContain("## Fix Instructions");
    expect(result).toContain("Address every review comment");
  });

  it("omits optional sections when their inputs are empty", () => {
    const result = assembleFixContext({
      ticket,
      prComments: [],
      failedChecks: [],
      repositories: [],
    });

    expect(result).toContain("# Fix Requirements");
    expect(result).toContain("## Acceptance Criteria");
    expect(result).not.toContain("## PR Review Feedback");
    expect(result).not.toContain("## CI/CD Check Results");
    expect(result).not.toContain("## Merge Conflicts");
    expect(result).not.toContain("## Selected Repositories");
    expect(result).not.toContain("## Fix Instructions");
  });
});

describe("clarifications section", () => {
  const baseTicket = {
    identifier: "TEST-42",
    title: "Ambiguous ticket",
    description: "d",
    acceptanceCriteria: "a",
    comments: [],
  };

  it("renders Q&A rounds in order with numbered questions and answer metadata", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        ...baseTicket,
        clarifications: [
          {
            questions: ["Which database?", "Which auth provider?"],
            answer: "Postgres and Auth0",
            answeredBy: "alice",
            answeredAt: "2026-07-16",
          },
          { questions: ["Deploy target?"], answer: "Vercel", answeredBy: "bob" },
        ],
      },
      prompt: "prompt",
      branchName: "blazebot/test-42",
    });

    expect(result).toContain("## Clarifications (Q&A)");
    expect(result).toContain("1. Which database?");
    expect(result).toContain("2. Which auth provider?");
    expect(result).toContain("Answer (by alice, 2026-07-16): Postgres and Auth0");
    expect(result).toContain("Answer (by bob): Vercel");

    // Rounds appear in order, placed between Comments and Branch.
    expect(result.indexOf("Postgres and Auth0")).toBeLessThan(result.indexOf("Vercel"));
    const clarIdx = result.indexOf("## Clarifications (Q&A)");
    expect(clarIdx).toBeGreaterThan(result.indexOf("## Comments"));
    expect(clarIdx).toBeLessThan(result.indexOf("## Branch"));
  });

  it("renders the section in every ticket-based context", () => {
    const clarifications = [{ questions: ["Q?"], answer: "A", answeredBy: "carol" }];
    const research = assembleResearchPlanContext({
      ticket: { ...baseTicket, clarifications },
      prompt: "p",
      branchName: "b",
    });
    const impl = assembleImplementationContext({
      ticket: { ...baseTicket, clarifications },
      prompt: "p",
      researchPlanMarkdown: "plan",
    });
    const review = assembleReviewContext({
      ticket: { ...baseTicket, clarifications },
      prompt: "p",
      researchPlanMarkdown: "plan",
    });
    const fix = assembleFixContext({
      ticket: { ...baseTicket, clarifications },
      prComments: [],
      failedChecks: [],
      repositories: [],
    });

    for (const out of [research, impl, review, fix]) {
      expect(out).toContain("## Clarifications (Q&A)");
      expect(out).toContain("Answer (by carol): A");
    }
  });

  it("produces no section when clarifications are absent or empty", () => {
    const absent = assembleResearchPlanContext({
      ticket: baseTicket,
      prompt: "p",
      branchName: "b",
    });
    expect(absent).not.toContain("## Clarifications (Q&A)");

    const empty = assembleImplementationContext({
      ticket: { ...baseTicket, clarifications: [] },
      prompt: "p",
      researchPlanMarkdown: "plan",
    });
    expect(empty).not.toContain("## Clarifications (Q&A)");
  });

  it("keeps the newest rounds within budget, dropping the oldest first with a note", () => {
    // Three ~7k-char rounds: two fit under the 16000 cap, the oldest does not.
    const round = (n: number) => ({
      questions: [`Round ${n} question?`],
      answer: "y".repeat(7000),
      answeredBy: `user${n}`,
    });
    const result = assembleResearchPlanContext({
      ticket: { ...baseTicket, clarifications: [round(1), round(2), round(3)] },
      prompt: "p",
      branchName: "b",
    });

    expect(result).toContain("## Clarifications (Q&A)");
    expect(result).toContain("[Older clarification rounds omitted to fit the prompt budget.]");
    // Newest rounds always present, oldest dropped first.
    expect(result).toContain("Round 3 question?");
    expect(result).toContain("Round 2 question?");
    expect(result).not.toContain("Round 1 question?");
  });

  it("emits no truncation note when every round fits", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        ...baseTicket,
        clarifications: [
          { questions: ["Q1?"], answer: "A1", answeredBy: "a" },
          { questions: ["Q2?"], answer: "A2", answeredBy: "b" },
        ],
      },
      prompt: "p",
      branchName: "b",
    });

    expect(result).toContain("Q1?");
    expect(result).toContain("Q2?");
    expect(result).not.toContain("[Older clarification rounds omitted to fit the prompt budget.]");
  });

  it("hard-truncates a single oversized round rather than dropping the newest", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        ...baseTicket,
        clarifications: [{ questions: ["Q?"], answer: "x".repeat(30000), answeredBy: "dan" }],
      },
      prompt: "p",
      branchName: "b",
    });

    expect(result).toContain("## Clarifications (Q&A)");
    expect(result).toContain("[Older clarification rounds omitted to fit the prompt budget.]");
    // The newest round's answer is still present (partially), never dropped.
    expect(result).toContain("Answer (by dan): xxx");
    // The oversized answer must not survive in full.
    expect(result).not.toContain("x".repeat(30000));
  });

  it("keeps the answer when the newest round's questions alone exceed the budget", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        ...baseTicket,
        clarifications: [
          { questions: ["q".repeat(30000)], answer: "USE POSTGRES", answeredBy: "dan" },
        ],
      },
      prompt: "p",
      branchName: "b",
    });

    // The answer survives in full even though the questions ate the budget.
    expect(result).toContain("Answer (by dan): USE POSTGRES");
    // The questions are truncated, not the answer.
    expect(result).toContain("### Round 1");
    expect(result).not.toContain("q".repeat(30000));
  });
});
