import { describe, expect, it } from "vitest";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { executorRunsOf, expectNeverInvoked } from "./assertions.js";
import { createScenario, type Scenario, type ScenarioOutcome } from "./harness.js";

/**
 * An already resolved ticket ends the run as a no-op: the planning agent
 * short-circuits with `terminal_success` (status "no_change_needed") instead
 * of handing the walk a plan, and the standard skip cascade takes every
 * downstream node with it. These scenarios drive the production v2
 * scheduler over the three shipped templates that carry a planning step, so
 * the cascade, the Branch/Loop control nodes and the second-trigger regions
 * are the real ones.
 *
 * The harness performs no side effects, so the Jira evidence comment, the
 * ticket move and the Slack note that `agent.ts` sends for a real no-op are
 * not asserted here; they are covered by unit tests and a live smoke test.
 */

const TICKET_ENTRY: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "AIW-232",
  ticketKey: "AIW-232",
  ownerToken: "owner-1",
};

const TICKET_CONTEXT = {
  identifier: "AIW-232",
  title: "Already resolved ticket",
  description: "Cover the already-resolved no-op with scenarios.",
  acceptanceCriteria: "Scenarios drive the production scheduler.",
  labels: ["ai"],
  comments: [],
};

const NO_CHANGE_OUTPUT = {
  status: "no_change_needed",
  plan: "already fixed",
  evidence: ["commit abc123"],
};

const PREPARED_WORKSPACE_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "ok",
    sandboxId: "sbx-scenario",
    repositories: ["github:acme/app"],
    workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
  },
};

/**
 * Asserts a node never reached a block executor and, wherever the scheduler
 * left a record for it, that record reports a skip rather than a failure.
 * The stronger claim than `expectNeverInvoked` alone: a downstream node that
 * silently failed instead of being skipped would still never "run" in the
 * executor sense, so the skip cascade needs its own check.
 */
function expectSkippedNotFailed(
  outcome: ScenarioOutcome,
  nodeIds: readonly string[],
): void {
  expectNeverInvoked(outcome, nodeIds);
  for (const nodeId of nodeIds) {
    for (const invocation of outcome.invocationsOf(nodeId)) {
      expect(invocation.runtimeState).not.toBe("failed");
    }
  }
}

describe("already resolved ticket: ticket-workflow", () => {
  function scenario(): Scenario {
    return createScenario({
      template: { id: "ticket-workflow", options: { includeReview: false } },
      entry: TICKET_ENTRY,
      entryTriggerId: "trigger",
      ticket: TICKET_CONTEXT,
    });
  }

  const DOWNSTREAM_OF_PLANNING = [
    "implementation",
    "checks",
    "finalize",
    "open-pr",
    "slack",
    "status",
  ];

  it("ends the walk as a completed no-op and never invokes anything downstream of planning", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      { kind: "terminal_success", output: NO_CHANGE_OUTPUT },
    );

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const planningRuns = executorRunsOf(outcome, "planning");
    expect(planningRuns).toHaveLength(1);
    expect(planningRuns[0].result).toEqual({
      kind: "terminal_success",
      output: NO_CHANGE_OUTPUT,
    });
    expectSkippedNotFailed(outcome, DOWNSTREAM_OF_PLANNING);
  });

  it("invokes implementation on an ordinary ready plan (normal-path regression)", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      { kind: "next", output: { status: "ready", plan: "Implement the ticket." } },
    );
    s.script({ nodeId: "implementation" }, {
      kind: "next",
      output: {
        status: "implemented",
        workspaceId: "sbx-scenario",
        branches: [],
        commits: [],
        summary: "Implemented.",
      },
    });
    s.script({ nodeId: "checks" }, {
      kind: "next",
      output: {
        status: "ok",
        ok: true,
        outcome: "passed",
        allPassed: true,
        anyFailed: false,
        groupCoverage: [],
        uncoveredGroupCount: 0,
        groupStatuses: [
          {
            provider: "github",
            repoPath: "acme/app",
            group: "checks",
            status: "passed",
          },
        ],
        results: [],
        failures: [],
        dirtied: [],
        setupFailed: false,
        fixCycles: 0,
        summary: "Checks passed.",
      },
    });
    s.script({ nodeId: "finalize" }, {
      kind: "next",
      output: {
        status: "finalized",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/app",
            branchName: "ai-workflow/AIW-232",
            defaultBranch: "main",
            expectedHead: "before",
            pushedHead: "after",
          },
        ],
      },
    });
    s.script({ nodeId: "open-pr" }, {
      kind: "next",
      output: {
        status: "ok",
        prs: [
          {
            provider: "github",
            repoPath: "acme/app",
            id: 1,
            url: "https://github.test/acme/app/pull/1",
            branch: "ai-workflow/AIW-232",
            isNew: true,
          },
        ],
        prUrl: "https://github.test/acme/app/pull/1",
        prNumber: 1,
      },
    });
    s.script({ nodeId: "slack" }, { kind: "next", output: { status: "ok" } });
    s.script({ nodeId: "status" }, {
      kind: "next",
      output: { status: "ok", target: "ai_review" },
    });

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    // Guards against an over-eager short-circuit at the scheduler level: an
    // ordinary "ready" plan must still reach implementation.
    expect(executorRunsOf(outcome, "implementation")).toHaveLength(1);
  });
});

describe("already resolved ticket: human-approved-plan", () => {
  function scenario(): Scenario {
    return createScenario({
      template: { id: "human-approved-plan", options: { includeReview: false } },
      entry: TICKET_ENTRY,
      entryTriggerId: "trigger-ticket",
      ticket: TICKET_CONTEXT,
    });
  }

  // "prepare-implementation", "implementation", "checks", "finalize",
  // "open-pr" and "status" all sit behind the second trigger
  // ("trigger-approved"), so they are unreachable from this entry regardless
  // of planning's outcome. They are asserted anyway so a future rewiring
  // that connects them directly to planning cannot silently skip a human
  // approval.
  const DOWNSTREAM_OF_PLANNING = [
    "send-approval",
    "prepare-implementation",
    "implementation",
    "checks",
    "finalize",
    "open-pr",
    "status",
  ];

  it("ends the walk as a completed no-op and never requests a human approval", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare-plan" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      { kind: "terminal_success", output: NO_CHANGE_OUTPUT },
    );

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const planningRuns = executorRunsOf(outcome, "planning");
    expect(planningRuns).toHaveLength(1);
    expect(planningRuns[0].result).toEqual({
      kind: "terminal_success",
      output: NO_CHANGE_OUTPUT,
    });
    // The acceptance criterion this template exists to prove: an
    // already-resolved ticket never reaches a human for plan approval.
    expectSkippedNotFailed(outcome, DOWNSTREAM_OF_PLANNING);
  });
});

describe("already resolved ticket: reviewed-ticket-workflow", () => {
  function scenario(): Scenario {
    return createScenario({
      template: {
        id: "reviewed-ticket-workflow",
        options: { includeReview: true, provider: "claude" as const },
      },
      entry: TICKET_ENTRY,
      entryTriggerId: "trigger",
      ticket: TICKET_CONTEXT,
    });
  }

  const DOWNSTREAM_OF_PLANNING = [
    "implementation",
    "security-review",
    "quality-review",
    "requirements-review",
    "reviews-approved",
    "checks",
    "finalize",
    "open-pr",
    "status",
    "retry",
    "fix",
    "exhausted-message",
    "exhausted-failure",
  ];

  it("ends the walk as a completed no-op and never invokes implementation, review or fix", async () => {
    const s = scenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script(
      { nodeId: "planning" },
      { kind: "terminal_success", output: NO_CHANGE_OUTPUT },
    );

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.executionError).toBeUndefined();
    const planningRuns = executorRunsOf(outcome, "planning");
    expect(planningRuns).toHaveLength(1);
    expect(planningRuns[0].result).toEqual({
      kind: "terminal_success",
      output: NO_CHANGE_OUTPUT,
    });
    expectSkippedNotFailed(outcome, DOWNSTREAM_OF_PLANNING);
  });
});
