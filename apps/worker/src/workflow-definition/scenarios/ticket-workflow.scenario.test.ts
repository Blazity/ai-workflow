import { describe, expect, it } from "vitest";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { executionError } from "../interpreter.js";
import { executorRunsOf, expectNeverInvoked } from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The `ticket-workflow` template (the default shipped graph) as an executable
 * specification: ticket entry through planning, implementation, checks,
 * finalize, PR, Slack and status update. Every scenario drives the production
 * v2 scheduler with review and leak review both off, the shape a fresh
 * install ships (`ENABLE_REVIEW_PHASE` / `ENABLE_LEAK_REVIEW` default false).
 *
 * Provider is fixed to "claude" throughout: it only threads into each agent
 * block's `harnessProfile.profileId`/`version`, which the harness never reads
 * (every block outcome is scripted), so varying it would test nothing new
 * while implying a matrix the harness does not have. "claude" matches the
 * majority of the existing scenario files.
 */

const TEMPLATE = {
  id: "ticket-workflow",
  options: { includeReview: false, provider: "claude" as const },
};

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-410",
  ticketKey: "AIW-410",
  ownerToken: "owner-1",
};

const TICKET_CONTEXT = {
  identifier: "AIW-410",
  title: "Ticket workflow scenarios",
  description: "Cover the ticket workflow template with scenarios.",
  acceptanceCriteria: "Scenarios drive the production scheduler.",
  labels: ["ai"],
  comments: [
    { author: "reporter", body: "Please ship this.", createdAt: "2026-01-01T00:00:00Z" },
  ],
};

/** The exact shape `ticketBindingFields` derives from `TICKET_CONTEXT`, reused
 * wherever a resolved input is asserted against it. */
const EXPECTED_TICKET_BINDING = {
  identifier: TICKET_CONTEXT.identifier,
  title: TICKET_CONTEXT.title,
  description: TICKET_CONTEXT.description,
  acceptanceCriteria: TICKET_CONTEXT.acceptanceCriteria,
  labels: TICKET_CONTEXT.labels,
  comments: TICKET_CONTEXT.comments,
  priorAnswers: [] as unknown[],
};

function scenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger",
    ticket: TICKET_CONTEXT,
  });
}

const PREPARED_WORKSPACE_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    sandboxId: "sbx-scenario",
    repositories: ["github:acme/app"],
    workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
  },
};

const CHECKS_PASSED_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    ok: true,
    outcome: "passed" as const,
    allPassed: true,
    anyFailed: false,
    groupCoverage: [],
    uncoveredGroupCount: 0,
    groupStatuses: [
      { provider: "github", repoPath: "acme/app", group: "checks", status: "passed" },
    ],
    results: [],
    failures: [],
    dirtied: [],
    setupFailed: false,
    fixCycles: 0,
    summary: "Checks passed.",
  },
};

const FINALIZE_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "finalized",
    repositories: [
      {
        provider: "github",
        repoPath: "acme/app",
        branchName: "ai-workflow/AIW-410",
        defaultBranch: "main",
        expectedHead: "before",
        pushedHead: "after",
      },
    ],
  },
};

const OPEN_PR_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    prs: [
      {
        provider: "github",
        repoPath: "acme/app",
        id: 1,
        url: "https://github.test/acme/app/pull/1",
        branch: "ai-workflow/AIW-410",
        isNew: true,
      },
    ],
    prUrl: "https://github.test/acme/app/pull/1",
    prNumber: 1,
  },
};

const DOWNSTREAM_OF_PLANNING = [
  "implementation",
  "checks",
  "finalize",
  "open-pr",
  "slack",
  "status",
];

describe("ticket workflow: happy path", () => {
  it("plans, implements, checks, finalizes, opens a PR and updates the ticket", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      { kind: "next", output: { status: "ready", plan: "Implement the fix." } },
    );
    s.script({ nodeId: "implementation" }, {
      kind: "next",
      output: {
        status: "implemented",
        workspaceId: "sbx-scenario",
        branches: [],
        commits: [],
        summary: "Implemented the fix.",
      },
    });
    s.script({ nodeId: "checks" }, CHECKS_PASSED_OUTPUT);
    s.script({ nodeId: "finalize" }, FINALIZE_OUTPUT);
    s.script({ nodeId: "open-pr" }, OPEN_PR_OUTPUT);
    s.script({ nodeId: "slack" }, { kind: "next", output: { status: "ok" } });
    s.script({ nodeId: "status" }, {
      kind: "next",
      output: { status: "ok", target: "ai_review" },
    });

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();

    // Bindings reach their real consumers, not just "something" downstream:
    // planning receives the exact ticket/comments/priorAnswers the trigger
    // published.
    expect(executorRunsOf(outcome, "planning")[0].resolvedInputs).toEqual({
      ticket: EXPECTED_TICKET_BINDING,
      comments: TICKET_CONTEXT.comments,
      priorAnswers: [],
    });
    // implementation receives the ticket again plus the plan planning just
    // produced, proving the planning -> implementation data handoff.
    expect(executorRunsOf(outcome, "implementation")[0].resolvedInputs).toEqual({
      ticket: EXPECTED_TICKET_BINDING,
      plan: "Implement the fix.",
    });
    // open-pr receives exactly the repositories finalize published.
    expect(executorRunsOf(outcome, "open-pr")[0].resolvedInputs).toEqual({
      repositories: FINALIZE_OUTPUT.output.repositories,
    });
  });
});

describe("ticket workflow: planning asks a clarifying question (a domain awaiting, not a failure)", () => {
  it("parks the run instead of failing it, and never proceeds to implementation", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "planning" }, {
      kind: "needs_human_input",
      output: { status: "needs_human_input" },
      questions: ["Which repository should this change land in?"],
    });

    const outcome = await s.execute();

    // "paused" is the scheduler's own name for a run parked on a
    // clarification. It must never collapse into "failed", the outcome an
    // execution_error produces, even though both leave the run unfinished.
    expect(outcome.result.outcome).toBe("paused");
    expect(outcome.result.executionError).toBeUndefined();
    expectNeverInvoked(outcome, DOWNSTREAM_OF_PLANNING);
  });
});

describe("ticket workflow: a critical technical failure", () => {
  it("fails the run and blocks every node downstream of planning", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      executionError("The planning sandbox crashed.", {
        category: "sandbox",
        phase: "agent",
      }),
    );

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toMatchObject({
      nodeId: "planning",
      category: "sandbox",
    });
    expectNeverInvoked(outcome, DOWNSTREAM_OF_PLANNING);
  });
});
