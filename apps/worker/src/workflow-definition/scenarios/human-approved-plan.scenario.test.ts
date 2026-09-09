import { describe, expect, it } from "vitest";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { executionError } from "../interpreter.js";
import { executorRunsOf, expectNeverInvoked } from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The `human-approved-plan` template as an executable specification. The
 * template spans two runs in production, joined only by a human clicking
 * "approve" on the dashboard: a `trigger-ticket` run plans and parks on
 * `send-approval`, and a later `trigger-approved` run resumes with the
 * approved plan. Each half gets its own scenario for the same reason
 * `no-change-ticket.scenario.test.ts` only drives the first half: a v2 walk
 * has exactly one entry, so a single scenario cannot span both triggers.
 *
 * Provider is fixed to "claude": see ticket-workflow.scenario.test.ts for why
 * varying it would not exercise anything the harness reads.
 */

const TEMPLATE = {
  id: "human-approved-plan",
  options: { includeReview: false, provider: "claude" as const },
};

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-411",
  ticketKey: "AIW-411",
  ownerToken: "owner-1",
};

const APPROVED_PLAN_MARKDOWN = "Implement the fix by doing X.";

const APPROVED_ENTRY: AgentWorkflowInput = {
  kind: "plan_approved",
  subjectKey: "AIW-411",
  ticketKey: "AIW-411",
  ownerToken: "owner-1",
  definitionId: 1,
  definitionVersion: 1,
  approvedPlan: { markdown: APPROVED_PLAN_MARKDOWN },
  approval: {
    approvalRequestId: "appr-1",
    approver: "alice",
    approvedAt: "2026-01-01T00:00:00Z",
  },
};

const TICKET_CONTEXT = {
  identifier: "AIW-411",
  title: "Human-approved plan scenarios",
  description: "Cover the human-approved-plan template with scenarios.",
  acceptanceCriteria: "Scenarios drive the production scheduler.",
  labels: ["ai"],
  comments: [],
};

const EXPECTED_TICKET_BINDING = {
  identifier: TICKET_CONTEXT.identifier,
  title: TICKET_CONTEXT.title,
  description: TICKET_CONTEXT.description,
  acceptanceCriteria: TICKET_CONTEXT.acceptanceCriteria,
  labels: TICKET_CONTEXT.labels,
  comments: TICKET_CONTEXT.comments,
  priorAnswers: [] as unknown[],
};

function ticketScenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: TICKET_ENTRY,
    entryTriggerId: "trigger-ticket",
    ticket: TICKET_CONTEXT,
  });
}

function approvedScenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: APPROVED_ENTRY,
    entryTriggerId: "trigger-approved",
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
        branchName: "ai-workflow/AIW-411",
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
        branch: "ai-workflow/AIW-411",
        isNew: true,
      },
    ],
    prUrl: "https://github.test/acme/app/pull/1",
    prNumber: 1,
  },
};

// "prepare-implementation", "implementation", "checks", "finalize", "open-pr"
// and "status" all sit behind the second trigger ("trigger-approved"), so
// they are unreachable from a trigger-ticket entry regardless of outcome.
const DOWNSTREAM_OF_APPROVAL = [
  "prepare-implementation",
  "implementation",
  "checks",
  "finalize",
  "open-pr",
  "status",
];

// A planning-time failure must also keep "send-approval" itself unreached: an
// already-failed plan is never filed for a human to approve.
const DOWNSTREAM_OF_PLANNING = ["send-approval", ...DOWNSTREAM_OF_APPROVAL];

describe("human-approved-plan: happy path, planning through approval", () => {
  it("plans and parks the run awaiting a human decision, never approving itself", async () => {
    const s = ticketScenario();
    s.script({ nodeId: "prepare-plan" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      { kind: "next", output: { status: "ready", plan: "Implement the fix by doing X." } },
    );
    s.script({ nodeId: "send-approval" }, {
      kind: "ended",
      output: { status: "awaiting_approval", approvalRequestId: "appr-1" },
    });

    const outcome = await s.execute();

    // "ended" is the scheduler's own name for a clean park via a block (here,
    // filing the approval request), distinct from "paused" (a clarification)
    // and from "failed" (an execution_error), proven below.
    expect(outcome.result.outcome).toBe("ended");
    expect(outcome.result.executionError).toBeUndefined();
    // Bindings reach their real consumer: send-approval receives exactly the
    // plan planning produced, not a stale or default one.
    expect(executorRunsOf(outcome, "send-approval")[0].resolvedInputs).toEqual({
      plan: "Implement the fix by doing X.",
    });
    expectNeverInvoked(outcome, DOWNSTREAM_OF_APPROVAL);
  });
});

describe("human-approved-plan: happy path, implementation after approval", () => {
  it("implements the approved plan, checks, finalizes, opens a PR and updates the ticket", async () => {
    const s = approvedScenario();
    s.script({ nodeId: "prepare-implementation" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "implementation" }, {
      kind: "next",
      output: {
        status: "implemented",
        workspaceId: "sbx-scenario",
        branches: [],
        commits: [],
        summary: "Implemented the approved plan.",
      },
    });
    s.script({ nodeId: "checks" }, CHECKS_PASSED_OUTPUT);
    s.script({ nodeId: "finalize" }, FINALIZE_OUTPUT);
    s.script({ nodeId: "open-pr" }, OPEN_PR_OUTPUT);
    s.script({ nodeId: "status" }, {
      kind: "next",
      output: { status: "ok", target: "ai_review" },
    });

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    // Bindings reach their real consumer: implementation receives the ticket
    // and the exact plan the trigger's approvedPlan carried, the second-run
    // binding path this template exists to prove ("steps.entry.output.
    // approvedPlan" rather than "steps.planning.output.plan").
    expect(executorRunsOf(outcome, "implementation")[0].resolvedInputs).toEqual({
      ticket: EXPECTED_TICKET_BINDING,
      plan: APPROVED_PLAN_MARKDOWN,
    });
    expect(executorRunsOf(outcome, "open-pr")[0].resolvedInputs).toEqual({
      repositories: FINALIZE_OUTPUT.output.repositories,
    });
  });
});

describe("human-approved-plan: a critical technical failure", () => {
  it("fails the run, blocks everything downstream of planning, and never requests a human approval", async () => {
    const s = ticketScenario();
    s.script({ nodeId: "prepare-plan" }, PREPARED_WORKSPACE_OUTPUT);
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
