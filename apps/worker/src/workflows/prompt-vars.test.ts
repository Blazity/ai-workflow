import { describe, it, expect } from "vitest";
import {
  buildPromptVariables,
  substitutePromptVariables,
  substituteNodePromptParams,
  VARIABLE_PARAM_KEYS,
} from "./prompt-vars.js";
import { PROMPT_VARIABLES, type WorkflowDefinitionNode } from "@shared/contracts";
import type { AgentWorkflowInput } from "./agent-input.js";
import type { WorkspacePublicationResult } from "./workspace-publication.js";
import type { WorkspaceRepositoryInput } from "../sandbox/repo-workspace.js";

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
    branchName: "ai/abc-123",
    entry: ticketEntry,
    researchPlanMarkdown: "",
    publication: null,
    selectedRepositories: [],
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

  it("resolves all twelve variables from a stubbed context", () => {
    const vars = buildPromptVariables(
      makeSource({
        entry: prEntry,
        researchPlanMarkdown: "1. Do the thing",
      }),
    );

    expect(vars).toEqual({
      ticket_key: "ABC-123",
      ticket_title: "Add dark mode",
      ticket_description: "Users want a dark theme.",
      ticket_acceptance_criteria: "Toggle persists across reloads.",
      ticket_labels: "frontend, ui",
      branch_name: "ai/abc-123",
      run_id: "run_abc",
      plan_markdown: "1. Do the thing",
      pr_number: "77",
      pr_url: "https://github.com/acme/api/pull/77",
      pr_title: "Implement dark mode",
      repo_path: "acme/api",
    });
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
  });

  it("resolves empty repo_path when neither PR entry nor a selected repo exists", () => {
    const vars = buildPromptVariables(makeSource({ entry: ticketEntry }));
    expect(vars.repo_path).toBe("");
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

describe("substituteNodePromptParams", () => {
  const vars = { ticket_title: "Add dark mode" };

  const makeNode = (
    type: WorkflowDefinitionNode["type"],
    params: WorkflowDefinitionNode["params"],
  ): WorkflowDefinitionNode => ({ id: "n1", type, x: 0, y: 0, params, inputs: {} });

  it("substitutes into a string param and returns a new node", () => {
    const node = makeNode("planning_agent", { prompt: "Plan {{ticket_title}}" });
    const result = substituteNodePromptParams(node, vars);
    expect(result).not.toBe(node);
    expect(result.params.prompt).toBe("Plan Add dark mode");
    // Original is untouched.
    expect(node.params.prompt).toBe("Plan {{ticket_title}}");
  });

  it("substitutes element-wise into a string[] param", () => {
    const node = makeNode("human_question", {
      questions: ["About {{ticket_title}}?", "Any other concerns?"],
    });
    const result = substituteNodePromptParams(node, vars);
    expect(result.params.questions).toEqual([
      "About Add dark mode?",
      "Any other concerns?",
    ]);
    // Input array is not mutated.
    expect(node.params.questions).toEqual([
      "About {{ticket_title}}?",
      "Any other concerns?",
    ]);
  });

  it("preserves node identity fields on the clone", () => {
    const node: WorkflowDefinitionNode = {
      id: "n7",
      type: "planning_agent",
      name: "Plan",
      x: 10,
      y: 20,
      inputs: {},
      params: { prompt: "{{ticket_title}}" },
      promptRefs: { prompt: { promptId: 3, version: 2 } },
    };
    const result = substituteNodePromptParams(node, vars);
    expect(result).not.toBe(node);
    expect(result.id).toBe("n7");
    expect(result.type).toBe("planning_agent");
    expect(result.name).toBe("Plan");
    expect(result.x).toBe(10);
    expect(result.y).toBe(20);
    expect(result.promptRefs).toBe(node.promptRefs);
  });

  it("returns the identical node for a block type with no variable params", () => {
    const node = makeNode("open_pr", { prompt: "{{ticket_title}}" });
    expect(substituteNodePromptParams(node, vars)).toBe(node);
  });

  it("returns the identical node when a variable param has no tokens", () => {
    const node = makeNode("planning_agent", { prompt: "Static prompt, no tokens" });
    expect(substituteNodePromptParams(node, vars)).toBe(node);
  });
});

describe("terminate postComment substitution", () => {
  // The terminate hook in agent.ts is dispatched inline by the interpreter and
  // never passes through substituteNodePromptParams, so it substitutes the
  // comment itself via substitutePromptVariables(buildPromptVariables(ctx)).
  // These cases pin that comment shape and the declaration the hook relies on.
  it("keeps terminate declared as a postComment variable param", () => {
    expect(VARIABLE_PARAM_KEYS.terminate).toEqual(["postComment"]);
  });

  it("resolves {{variables}} in a terminate comment string", () => {
    const resolved = buildPromptVariables(makeSource());
    expect(
      substitutePromptVariables("Parked {{ticket_key}}: {{ticket_title}}", resolved),
    ).toBe("Parked ABC-123: Add dark mode");
  });
});
