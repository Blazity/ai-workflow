import { describe, it, expect } from "vitest";
import {
  buildPromptVariables,
} from "./prompt-output.js";
import {
  PROMPT_VARIABLES,
  substitutePromptVariables,
} from "@shared/prompts";
import type { AgentWorkflowInput } from "../agent-input.js";
import type { WorkspacePublicationResult } from "../steps/workspace-publication.js";
import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";

// Source is the internal Pick<EngineCtx, ...> buildPromptVariables reads. Derive
// it from the function so the test never drifts from the real parameter shape.
type Source = Parameters<typeof buildPromptVariables>[0];

const baseTicket = {
  id: "10001",
  identifier: "ABC-123",
  title: "Add dark mode",
  description: "Users want a dark theme.",
  acceptanceCriteria: "Toggle persists across reloads.",
  comments: [],
  labels: ["frontend", "ui"],
  trackerStatus: "AI",
  attachments: [],
};

const ticketEntry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "jira:ABC-123",
  ticketKey: "ABC-123",
  ownerToken: "owner-token",
};

const prEntry: AgentWorkflowInput = {
  kind: "pr_trigger",
  triggerType: "trigger_pr_review",
  subjectKey: "github:acme/api#77",
  ticketKey: "ABC-123",
  ownerToken: "owner-token",
  definitionId: 1,
  definitionVersion: 1,
  scope: "workflow_owned",
  pr: {
    provider: "github",
    repoPath: "acme/api",
    prNumber: 77,
    prUrl: "https://github.com/acme/api/pull/77",
    headRef: "feature",
    headSha: "abc123",
    baseRef: "main",
    title: "Implement dark mode",
    author: "octocat",
    isDraft: false,
  },
};

const openedPrPublication = {
  status: "published",
  prs: [
    {
      provider: "github",
      repoPath: "acme/api",
      id: 42,
      url: "https://github.com/acme/api/pull/42",
      branch: "ai/abc-123",
      isNew: true,
    },
  ],
} as unknown as WorkspacePublicationResult;

const selectedRepos: WorkspaceRepositoryInput[] = [
  {
    provider: "github",
    repoPath: "acme/web",
    defaultBranch: "main",
    selectedRationale: "primary",
  },
];

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    runId: "run_abc",
    ticket: baseTicket,
    ticketUrl: "",
    branchName: "ai/abc-123",
    entry: ticketEntry,
    researchPlanMarkdown: "",
    changeSummary: "",
    publication: null,
    selectedRepositories: [],
    repositoryContexts: [],
    ...overrides,
  };
}

describe("buildPromptVariables", () => {
  it("produces exactly the variables the shared PROMPT_VARIABLES catalog advertises", () => {
    // PromptVariableValues is Partial, so nothing but this test catches a
    // variable that the catalog (autocomplete, docs) lists yet the builder
    // silently stopped producing, or vice versa.
    const vars = buildPromptVariables(makeSource());
    expect(Object.keys(vars).sort()).toEqual(PROMPT_VARIABLES.map((v) => v.name).sort());
  });

  it("resolves every variable from a stubbed context", () => {
    const vars = buildPromptVariables(
      makeSource({
        entry: prEntry,
        ticketUrl: "https://jira.example.com/browse/ABC-123",
        researchPlanMarkdown: "1. Do the thing",
        changeSummary: "Added a theme toggle that persists.",
      }),
    );

    expect(vars).toEqual({
      ticket_key: "ABC-123",
      ticket_title: "Add dark mode",
      ticket_url: "https://jira.example.com/browse/ABC-123",
      ticket_description: "Users want a dark theme.",
      ticket_acceptance_criteria: "Toggle persists across reloads.",
      ticket_labels: "frontend, ui",
      change_summary: "Added a theme toggle that persists.",
      branch_name: "ai/abc-123",
      run_id: "run_abc",
      plan_markdown: "1. Do the thing",
      pr_number: "77",
      pr_url: "https://github.com/acme/api/pull/77",
      pr_title: "Implement dark mode",
      repo_path: "acme/api",
      repo_default_branch: "main",
      pr_review_feedback: "",
    });
  });

  it("renders pr_review_feedback from workflow-owned PR comments, empty when none", () => {
    expect(buildPromptVariables(makeSource()).pr_review_feedback).toBe("");

    const vars = buildPromptVariables(
      makeSource({
        repositoryContexts: [
          {
            repository: {
              provider: "github",
              repoPath: "acme/api",
              defaultBranch: "main",
              selectedRationale: "workflow-owned branch for this ticket",
            },
            prComments: [
              { author: "reviewer", body: "[Review: changes requested] fix the null check", liked: false },
            ],
            checkResults: [],
            hasConflicts: false,
          },
        ],
      }),
    );
    expect(vars.pr_review_feedback).toContain("### github:acme/api");
    expect(vars.pr_review_feedback).toContain("fix the null check");
  });

  it("keeps each repository's feedback under its own heading in multi-repo runs", () => {
    const context = (repoPath: string, body: string) => ({
      repository: {
        provider: "github" as const,
        repoPath,
        defaultBranch: "main",
        selectedRationale: "workflow-owned branch for this ticket",
      },
      prComments: [{ author: "reviewer", body, liked: false }],
      checkResults: [],
      hasConflicts: false,
    });
    const vars = buildPromptVariables(
      makeSource({
        repositoryContexts: [
          context("acme/api", "fix the api null check"),
          context("acme/web", "fix the web button copy"),
        ],
      }),
    );
    // Repo identity is preserved so same-path comments never get conflated.
    expect(vars.pr_review_feedback).toContain("### github:acme/api");
    expect(vars.pr_review_feedback).toContain("fix the api null check");
    expect(vars.pr_review_feedback).toContain("### github:acme/web");
    expect(vars.pr_review_feedback).toContain("fix the web button copy");
    // api heading precedes web's (order follows repositoryContexts).
    expect(vars.pr_review_feedback!.indexOf("acme/api")).toBeLessThan(
      vars.pr_review_feedback!.indexOf("acme/web"),
    );
  });

  it("leaves pr variables empty on a ticket-triggered run", () => {
    const vars = buildPromptVariables(makeSource({ entry: ticketEntry }));
    expect(vars.pr_number).toBe("");
    expect(vars.pr_url).toBe("");
    expect(vars.pr_title).toBe("");
  });

  it("populates pr variables from the triggering PR entry", () => {
    const vars = buildPromptVariables(makeSource({ entry: prEntry }));
    expect(vars.pr_number).toBe("77");
    expect(vars.pr_url).toBe("https://github.com/acme/api/pull/77");
    expect(vars.pr_title).toBe("Implement dark mode");
    expect(vars.repo_path).toBe("acme/api");
  });

  it("falls back to the opened PR for pr_number/pr_url on a ticket run", () => {
    const vars = buildPromptVariables(
      makeSource({ entry: ticketEntry, publication: openedPrPublication }),
    );
    expect(vars.pr_number).toBe("42");
    expect(vars.pr_url).toBe("https://github.com/acme/api/pull/42");
    // pr_title has no non-PR-entry source, so it stays empty.
    expect(vars.pr_title).toBe("");
  });

  it("falls back to the first selected repository for repo_path", () => {
    const vars = buildPromptVariables(
      makeSource({ entry: ticketEntry, selectedRepositories: selectedRepos }),
    );
    expect(vars.repo_path).toBe("acme/web");
    expect(vars.repo_default_branch).toBe("main");
  });

  it("constructs repository-scoped values separately for a two-repository run", () => {
    const source = makeSource({
      entry: ticketEntry,
      selectedRepositories: [
        ...selectedRepos,
        {
          provider: "gitlab",
          repoPath: "acme/api",
          defaultBranch: "trunk",
          selectedRationale: "backend",
        },
      ],
    });

    expect(
      source.selectedRepositories.map((repository) => {
        const vars = buildPromptVariables(source, repository);
        return [vars.repo_path, vars.repo_default_branch];
      }),
    ).toEqual([
      ["acme/web", "main"],
      ["acme/api", "trunk"],
    ]);
  });

  it("resolves empty repo_path when neither PR entry nor a selected repo exists", () => {
    const vars = buildPromptVariables(makeSource({ entry: ticketEntry }));
    expect(vars.repo_path).toBe("");
    expect(vars.repo_default_branch).toBe("");
  });
});

describe("substitutePromptVariables", () => {
  const vars = { ticket_title: "Add dark mode", pr_number: "" };

  it("substitutes a known token", () => {
    expect(substitutePromptVariables("Work on {{ticket_title}}", vars)).toBe(
      "Work on Add dark mode",
    );
  });

  it("leaves an unknown token verbatim", () => {
    expect(substitutePromptVariables("Value: {{nope}}", vars)).toBe("Value: {{nope}}");
  });

  it("tolerates inner whitespace around a known name", () => {
    expect(substitutePromptVariables("{{ ticket_title }}", vars)).toBe("Add dark mode");
  });

  it("does not match an uppercase name and leaves it verbatim", () => {
    expect(substitutePromptVariables("{{Ticket_Title}}", vars)).toBe("{{Ticket_Title}}");
  });

  it("substitutes a known variable with an empty value to an empty string", () => {
    expect(substitutePromptVariables("PR #{{pr_number}}", vars)).toBe("PR #");
  });
});
