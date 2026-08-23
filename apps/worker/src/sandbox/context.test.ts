import { describe, it, expect } from "vitest";
import type { ReviewThreadFeed } from "../adapters/vcs/types.js";
import type { WorkspaceRepoV2 } from "./repo-workspace.js";
import {
  assembleResearchPlanContext,
  assembleImplementationContext,
  assembleReviewContext,
  assembleFixContext,
  formatCheckResults,
} from "./context.js";

function manifestRepo(
  provider: "github" | "gitlab",
  repoPath: string,
  localPath: string,
  access: "read" | "write",
): WorkspaceRepoV2 {
  return {
    provider,
    repoPath,
    slug: `${provider}__${repoPath.replace(/[^a-z0-9]+/gi, "__")}`,
    localPath,
    defaultBranch: "main",
    branchName: "b",
    selectedRationale: `rationale ${repoPath}`,
    access,
    researchBaseSha: `sha-${repoPath}`,
  };
}

describe("assembleResearchPlanContext", () => {
  it("always appends the current repository access protocol after stored prompt text", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "AIW-147",
        title: "Research repositories",
        description: "Trace ownership",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "Legacy output format.",
      branchName: "blazebot/aiw-147",
    });

    expect(result.indexOf("Legacy output format.")).toBeLessThan(
      result.indexOf("## Repository Access Protocol"),
    );
    expect(result).toContain('status: "repositories_needed"');
    expect(result).toContain("writeRepositories");
    expect(result).toContain("Research is read-only");
  });

  it("adds a Resolution Check section instructing the agent to look for prior fixes", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "AIW-232",
        title: "Already resolved ticket",
        description: "Ticket says Fixed in a comment.",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "",
      branchName: "blazebot/aiw-232",
    });

    expect(result).toContain("## Resolution Check");
    expect(result.indexOf("## Repository Access Protocol")).toBeLessThan(
      result.indexOf("## Resolution Check"),
    );
    expect(result).toContain('noChangeNeeded: true');
    expect(result).toContain("resolutionEvidence");
  });

  it("omits the Resolution Check when repository contexts carry PR review feedback", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-10",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "",
      branchName: "blazebot/test-10",
      repositoryContexts: [
        {
          repository: {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch for this ticket",
          },
          prComments: [
            { author: "Bob", body: "please add the missing null check", liked: false },
          ],
          checkResults: [],
          hasConflicts: false,
        },
      ],
    });

    expect(result).not.toContain("## Resolution Check");
    expect(result).toContain("## Existing pull request — address this review feedback");
    expect(result).toContain("Research is read-only");
  });

  it("keeps the Resolution Check when repository contexts have no PR comments", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-11",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "",
      branchName: "blazebot/test-11",
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
    });

    expect(result).toContain("## Resolution Check");
  });

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

  it("renders discovery-promoted repositories from their trusted manifest paths", () => {
    const result = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      selectedRepositories: [
        { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "api" },
        { provider: "github", repoPath: "acme/web", defaultBranch: "main", selectedRationale: "web" },
      ],
      workspaceManifest: {
        version: 2,
        repositories: [
          manifestRepo("github", "acme/api", "/vercel/sandbox/repos/github__acme__api", "write"),
          manifestRepo("github", "acme/web", "/vercel/sandbox/repos/github__acme__web", "read"),
        ],
      },
    });

    expect(result).toContain("`github:acme/api` at `/vercel/sandbox/repos/github__acme__api`");
    expect(result).toContain("`github:acme/web` at `/vercel/sandbox/repos/github__acme__web`");
    expect(result).toContain("`/vercel/sandbox/repos/github__acme__api` (write)");
    expect(result).toContain("`/vercel/sandbox/repos/github__acme__web` (read-only)");
    expect(result).toContain("Only repositories marked write may be modified");
    expect(result).toContain("Read-only repositories are context only");
  });

  it("renders legacy root layout paths from the trusted manifest", () => {
    const result = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      selectedRepositories: [
        { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "api" },
        { provider: "github", repoPath: "acme/web", defaultBranch: "main", selectedRationale: "web" },
      ],
      workspaceManifest: {
        version: 2,
        repositories: [
          manifestRepo("github", "acme/api", "/vercel/sandbox", "write"),
          manifestRepo("github", "acme/web", "/vercel/sandbox/repos/github__acme__web", "read"),
        ],
      },
    });

    expect(result).toContain("`github:acme/api` at `/vercel/sandbox`");
    expect(result).toContain("`github:acme/web` at `/vercel/sandbox/repos/github__acme__web`");
  });

  it("rejects a selected repository whose manifest path escapes the workspace", () => {
    expect(() =>
      assembleResearchPlanContext({
        ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
        prompt: "p",
        branchName: "b",
        selectedRepositories: [
          { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "api" },
        ],
        workspaceManifest: {
          version: 2,
          repositories: [
            manifestRepo("github", "acme/api", "/vercel/sandbox/../secrets", "write"),
          ],
        },
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects a selected repository nested below its repos directory", () => {
    expect(() =>
      assembleResearchPlanContext({
        ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
        prompt: "p",
        branchName: "b",
        selectedRepositories: [
          { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "api" },
        ],
        workspaceManifest: {
          version: 2,
          repositories: [
            manifestRepo("github", "acme/api", "/vercel/sandbox/repos/github__acme__api/nested", "write"),
          ],
        },
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects duplicate manifest paths across selected repositories", () => {
    expect(() =>
      assembleResearchPlanContext({
        ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
        prompt: "p",
        branchName: "b",
        selectedRepositories: [
          { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "api" },
          { provider: "github", repoPath: "acme/web", defaultBranch: "main", selectedRationale: "web" },
        ],
        workspaceManifest: {
          version: 2,
          repositories: [
            manifestRepo("github", "acme/api", "/vercel/sandbox", "write"),
            manifestRepo("github", "acme/web", "/vercel/sandbox", "read"),
          ],
        },
      }),
    ).toThrow(/duplicat/i);
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

describe("runtime-only context assembly", () => {
  it("omits the role-prompt divider when the effective compiler requests runtime data", () => {
    const ticket = {
      identifier: "AIW-124",
      title: "Prompt authoring",
      description: "Compile one effective prompt.",
      acceptanceCriteria: "Preview and runtime match.",
      comments: [],
    };
    const research = assembleResearchPlanContext({
      ticket,
      prompt: "",
      branchName: "ai-workflow/AIW-124",
    });
    const implementation = assembleImplementationContext({
      ticket,
      prompt: "",
      researchPlanMarkdown: "Approved plan",
    });
    const review = assembleReviewContext({
      ticket,
      prompt: "",
      researchPlanMarkdown: "Approved plan",
    });

    for (const runtimeData of [research, implementation, review]) {
      expect(runtimeData).not.toContain("\n---\n");
    }
  });
});

describe("assembleReviewContext", () => {
  it("renders read-only sibling repositories with their local path, URL, and SHA", () => {
    const result = assembleReviewContext({
      ticket: {
        identifier: "TEST-SIBLING",
        title: "Cross-repository review",
        description: "Check the API contract.",
        acceptanceCriteria: "The caller matches the API.",
        comments: [],
      },
      prompt: "",
      researchPlanMarkdown: "plan",
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "current PR",
          workflowOwnedBranch: { branchName: "feature", pr: { id: 1, url: "https://github/web/pull/1", branch: "feature" } },
        },
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "sibling PR",
          reviewPullRequest: {
            id: 2,
            url: "https://github/api/pull/2",
            branch: "main",
            headSha: "api-sha",
          },
        },
      ],
    });

    expect(result).toContain("## Review Sibling Repositories");
    expect(result).toContain("acme/api");
    expect(result).toContain("/vercel/sandbox/repos/github__acme__api");
    expect(result).toContain("https://github/api/pull/2");
    expect(result).toContain("api-sha");
    expect(result).toContain("set its `repo` field");
  });

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

  it("includes explicitly supplied typed pull request review feedback", () => {
    const result = assembleReviewContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are a review agent...",
      researchPlanMarkdown: "# Plan",
      reviewFeedback: {
        state: "changes_requested",
        author: "Alice",
        body: "Please cover the failure path.",
      },
    });

    expect(result).toContain("## Pull request review feedback");
    expect(result).toContain("State: changes_requested");
    expect(result).toContain("Alice: Please cover the failure path.");
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
  it("delimits ordered internal review results without mixing them into PR feedback", () => {
    const result = assembleFixContext({
      ticket: {
        identifier: "AIW-186",
        title: "Reviewed workflow",
        description: "",
        acceptanceCriteria: "",
        comments: [],
      },
      prComments: [],
      failedChecks: [],
      reviewResults: [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Fix this.",
              severity: "Blocker",
            },
          ],
        },
        {
          decision: "approve",
          findings: [],
        },
      ],
      repositories: [],
    });

    expect(result).toContain("## Internal Review Results");
    expect(result).toContain("<review-results>");
    expect(result).toContain('"decision": "request_changes"');
    expect(result.indexOf('"decision": "request_changes"')).toBeLessThan(
      result.indexOf('"decision": "approve"'),
    );
    expect(result).not.toContain("## PR Review Feedback");
  });

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

describe("review ledger prompt section", () => {
  const ticket = {
    identifier: "AWP-107",
    title: "Remediate the review",
    description: "d",
    acceptanceCriteria: "",
    comments: [],
  };

  const note = (author: string, body: string, isLedgerReply = false) => ({
    author,
    body,
    createdAt: "2026-08-20T10:00:00.000Z",
    isLedgerReply,
  });

  const feed = (): ReviewThreadFeed => ({
    threads: [
      {
        threadId: "d-1",
        alias: "T1",
        source: "human",
        resolvable: true,
        awaitingHuman: false,
        filePath: "src/auth/session.ts",
        line: 42,
        notes: [
          note("alice", "This drops the null check we discussed."),
          note("bob", "Agreed, please restore it."),
        ],
      },
      {
        threadId: "d-2",
        alias: "T2",
        source: "bot",
        resolvable: false,
        awaitingHuman: false,
        notes: [note("ai-workflow", "The migration number collides with 0044.")],
      },
      {
        threadId: "d-3",
        alias: "T3",
        source: "human",
        resolvable: true,
        awaitingHuman: true,
        filePath: "src/db/schema.ts",
        notes: [
          note("carol", "Why is this nullable?"),
          note("ai-workflow", "Already addressed in `src/db/schema.ts`.", true),
        ],
      },
      {
        threadId: "d-4",
        alias: "T4",
        source: "third_party",
        resolvable: true,
        awaitingHuman: false,
        notes: [note("coderabbitai", "Consider extracting this helper.")],
      },
    ],
    truncated: 3,
    snapshotAt: "2026-08-21T09:00:00.000Z",
  });

  const contextWithFeed = () => [
    {
      repository: {
        provider: "gitlab" as const,
        repoPath: "acme/api",
        defaultBranch: "main",
        selectedRationale: "workflow-owned branch for this ticket",
      },
      prComments: [
        { author: "alice", body: "This drops the null check we discussed.", liked: false },
      ],
      checkResults: [],
      hasConflicts: false,
      reviewThreads: feed(),
    },
  ];

  const research = () =>
    assembleResearchPlanContext({
      ticket,
      prompt: "",
      branchName: "blazebot/awp-107",
      repositoryContexts: contextWithFeed(),
    });

  it("renders every work item with its alias, source, location and full notes", () => {
    const result = research();

    expect(result).toContain("## Review Threads: gitlab:acme/api");
    expect(result).toContain("### T1 (human) in `src/auth/session.ts` line 42");
    expect(result).toContain("alice: This drops the null check we discussed.");
    expect(result).toContain("bob: Agreed, please restore it.");
    expect(result).toContain("### T2 (our bot), general comment");
    expect(result).toContain("ai-workflow: The migration number collides with 0044.");
  });

  it("keeps threads awaiting a human and third-party bot threads out of the answer list", () => {
    const result = research();
    const contextHeading = result.indexOf("### Context only: do not disposition these");

    expect(contextHeading).toBeGreaterThan(-1);
    expect(result).toContain("T3 (human) in `src/db/schema.ts`: waiting on a human reply");
    expect(result).toContain("T4 (another vendor's bot): not answered by this workflow");
    // Both must sit inside the context block, after the answerable work items.
    expect(result.indexOf("### T1 (human)")).toBeLessThan(contextHeading);
    expect(result.indexOf("### T2 (our bot)")).toBeLessThan(contextHeading);
  });

  it("states the disposition contract including the now-versus-this-run rule", () => {
    const result = research();

    expect(result).toContain("`reviewThreads`");
    expect(result).toContain("`actionable`");
    expect(result).toContain("`already_addressed`");
    expect(result).toContain("`question`");
    expect(result).toContain("`out_of_scope`");
    expect(result).toContain(
      "`already_addressed` means the change is on the branch right now",
    );
    expect(result).toContain(
      "If it only comes into existence during this run, the disposition is `actionable`",
    );
  });

  it("names the threads that did not fit into this run", () => {
    expect(research()).toContain(
      "3 further threads did not fit into this run and are left for the next one.",
    );
  });

  it("replaces the flat comment list only where the feed covers it", () => {
    const result = research();

    expect(result).not.toContain("## PR Review Feedback: gitlab:acme/api");
    // The remediation framing still leads, because the task is still the review.
    expect(result).toContain("## Existing pull request");
  });

  it("keeps flat comments the feed does not carry, such as a review summary", () => {
    const result = assembleResearchPlanContext({
      ticket,
      prompt: "",
      branchName: "blazebot/awp-107",
      repositoryContexts: [
        {
          ...contextWithFeed()[0]!,
          prComments: [
            // Covered: this is T1's first note.
            { author: "alice", body: "This drops the null check we discussed.", liked: false },
            // Not covered: a GitHub review submission body is not a thread, so
            // it exists nowhere in the feed.
            {
              author: "alice",
              body: "Requesting changes: the session work needs another pass.",
              liked: false,
            },
          ],
        },
      ],
    });

    expect(result).toContain("## PR Review Feedback: gitlab:acme/api");
    expect(result).toContain("Requesting changes: the session work needs another pass.");
    // The covered note appears once, under its alias, not twice.
    expect(
      result.split("This drops the null check we discussed.").length - 1,
    ).toBe(1);
  });

  it("renders full note bodies for the context-only threads", () => {
    const result = research();

    // Both a scanner's finding and a thread we already answered carry content
    // that exists nowhere else once the flat list is pruned.
    expect(result).toContain("coderabbitai: Consider extracting this helper.");
    expect(result).toContain("carol: Why is this nullable?");
    expect(result).toContain("ai-workflow: Already addressed in `src/db/schema.ts`.");
  });

  it("omits the Resolution Check when there are review threads to answer", () => {
    expect(research()).not.toContain("## Resolution Check");
  });

  it("carries the same section into the implementation prompt", () => {
    const result = assembleImplementationContext({
      ticket,
      prompt: "",
      researchPlanMarkdown: "plan",
      repositoryContexts: contextWithFeed(),
    });

    expect(result).toContain("### T1 (human) in `src/auth/session.ts` line 42");
    expect(result).toContain("`already_addressed` means the change is on the branch right now");
  });

  it("carries the same section into the fix prompt", () => {
    const result = assembleFixContext({
      ticket,
      prComments: [{ author: "alice", body: "This drops the null check we discussed.", liked: false }],
      failedChecks: [],
      repositories: [],
      reviewThreads: feed(),
    });

    expect(result).toContain("## Review Threads");
    expect(result).toContain("### T1 (human) in `src/auth/session.ts` line 42");
    expect(result).not.toContain("## PR Review Feedback");
  });

  it("leaves both prompts untouched when no feed is attached", () => {
    const withoutFeed = assembleResearchPlanContext({
      ticket,
      prompt: "",
      branchName: "blazebot/awp-107",
      repositoryContexts: contextWithFeed().map(
        ({ reviewThreads: _dropped, ...rest }) => rest,
      ),
    });

    expect(withoutFeed).not.toContain("## Review Threads");
    expect(withoutFeed).toContain("## PR Review Feedback: gitlab:acme/api");
    expect(
      assembleFixContext({
        ticket,
        prComments: [{ author: "alice", body: "x", liked: false }],
        failedChecks: [],
        repositories: [],
      }),
    ).toContain("## PR Review Feedback");
  });

  it("drops the answer list when every thread is context only", () => {
    // Round C in production: nobody wrote anything new, every thread already
    // carries our reply, and the PR still returns all of its comments. The
    // fixture keeps those comments, because a fixture without them hides the
    // fact that the run has nothing left to do.
    const contextOnly = feed();
    contextOnly.threads = contextOnly.threads.filter(
      (thread) => thread.awaitingHuman || thread.source === "third_party",
    );
    const result = assembleResearchPlanContext({
      ticket,
      prompt: "",
      branchName: "blazebot/awp-107",
      repositoryContexts: [
        {
          ...contextWithFeed()[0]!,
          prComments: [
            { author: "carol", body: "Why is this nullable?", liked: false },
            { author: "coderabbitai", body: "Consider extracting this helper.", liked: false },
          ],
          reviewThreads: contextOnly,
        },
      ],
    });

    expect(result).toContain("### Context only: do not disposition these");
    expect(result).not.toContain("Answer every alias");
    expect(result).not.toContain("### How to answer");
    // Nothing is left over for the flat list: the feed carries both comments.
    expect(result).not.toContain("## PR Review Feedback: gitlab:acme/api");
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
