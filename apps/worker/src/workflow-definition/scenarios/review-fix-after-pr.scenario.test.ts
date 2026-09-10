import { describe, expect, it } from "vitest";
import type { AgentWorkflowInput } from "../../engine/agent-input.js";
import { executionError } from "../interpreter.js";
import { executorRunsOf, expectNeverInvoked } from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";

/**
 * The `review-fix-after-pr` template as an executable specification. Two
 * authored triggers, "PR checks failed" and "PR review submitted", both edge
 * into the same "prepare" node: whichever one a run enters through, the fix
 * agent resolves the feedback and pushes a follow-up commit. The happy path
 * below drives both entries through the identical downstream chain; the
 * failure and domain-awaiting paths only need one, since the fix agent's
 * behaviour there does not depend on which trigger started the run.
 *
 * Provider is fixed to "claude": see ticket-workflow.scenario.test.ts for why
 * varying it would not exercise anything the harness reads.
 */

const TEMPLATE = {
  id: "review-fix-after-pr",
  options: { includeReview: false, provider: "claude" as const },
};

function checksFailedEntry(): AgentWorkflowInput {
  return {
    kind: "pr_trigger",
    triggerType: "trigger_pr_checks_failed",
    subjectKey: "pr:github:acme/app#42",
    ticketKey: "AIW-413",
    ownerToken: "owner-1",
    definitionId: 1,
    definitionVersion: 1,
    scope: "workflow_owned",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 42,
      prUrl: "https://github.test/acme/app/pull/42",
      headRef: "feature",
      headSha: "abc123",
      baseRef: "main",
      title: "Add the fix",
      author: "contributor",
      isDraft: false,
      failedChecks: [{ name: "CI", conclusion: "failure" }],
    },
  };
}

function reviewEntry(): AgentWorkflowInput {
  return {
    kind: "pr_trigger",
    triggerType: "trigger_pr_review",
    subjectKey: "pr:github:acme/app#42",
    ticketKey: "AIW-413",
    ownerToken: "owner-1",
    definitionId: 1,
    definitionVersion: 1,
    scope: "workflow_owned",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 42,
      prUrl: "https://github.test/acme/app/pull/42",
      headRef: "feature",
      headSha: "abc123",
      baseRef: "main",
      title: "Add the fix",
      author: "contributor",
      isDraft: false,
      review: { state: "changes_requested", author: "reviewer", body: "Please fix the null check." },
    },
  };
}

function checksFailedScenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: checksFailedEntry(),
    entryTriggerId: "trigger-checks-failed",
  });
}

function reviewScenario(): Scenario {
  return createScenario({
    template: TEMPLATE,
    entry: reviewEntry(),
    entryTriggerId: "trigger-review",
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

const FETCH_CONTEXT_OUTPUT = {
  kind: "next" as const,
  output: { status: "ok", contexts: [] },
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
        branchName: "feature",
        defaultBranch: "main",
        expectedHead: "abc123",
        pushedHead: "def456",
      },
    ],
  },
};

const FIX_SUMMARY = "Fixed the failing CI check by correcting the null check.";

const FIX_OUTPUT = {
  kind: "next" as const,
  output: {
    status: "fixed",
    workspaceId: "sbx-scenario",
    commits: [],
    resolvedConflicts: [],
    unresolvedConflicts: [],
    summary: FIX_SUMMARY,
  },
};

const HAPPY_PATH_ENTRIES: Array<{ label: string; build: () => Scenario }> = [
  { label: "a failed checks trigger", build: checksFailedScenario },
  { label: "a requested-changes review trigger", build: reviewScenario },
];

describe("review-fix-after-pr: happy path", () => {
  it.each(HAPPY_PATH_ENTRIES)(
    "resolves the feedback, fixes, checks, finalizes and comments on the PR ($label)",
    async ({ build }) => {
      const s = build();
      s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
      s.script({ nodeId: "fetch-context" }, FETCH_CONTEXT_OUTPUT);
      s.script({ nodeId: "fix" }, FIX_OUTPUT);
      s.script({ nodeId: "checks" }, CHECKS_PASSED_OUTPUT);
      s.script({ nodeId: "finalize" }, FINALIZE_OUTPUT);
      s.script({ nodeId: "comment" }, { kind: "next", output: { status: "ok", comments: [] } });

      const outcome = await s.execute();

      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.executionError).toBeUndefined();
      // Bindings reach their real consumer: the PR comment carries exactly
      // the fix agent's own summary, not the block's static fallback body.
      expect(executorRunsOf(outcome, "comment")[0].resolvedInputs).toEqual({
        body: FIX_SUMMARY,
      });
    },
  );
});

describe("review-fix-after-pr: fix agent asks a clarifying question (a domain awaiting, not a failure)", () => {
  it("parks the run instead of failing it, and never proceeds to checks", async () => {
    const s = checksFailedScenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "fetch-context" }, FETCH_CONTEXT_OUTPUT);
    s.script({ nodeId: "fix" }, {
      kind: "needs_human_input",
      output: { status: "needs_human_input" },
      questions: ["Which of the two conflicting fixes should win?"],
    });

    const outcome = await s.execute();

    // "paused" (a clarification) must never collapse into "failed", the
    // outcome an execution_error produces, proven in the next describe block.
    expect(outcome.result.outcome).toBe("paused");
    expect(outcome.result.executionError).toBeUndefined();
    expectNeverInvoked(outcome, ["checks", "finalize", "comment"]);
  });
});

describe("review-fix-after-pr: a critical technical failure", () => {
  it("fails the run and blocks every node downstream of the fix agent", async () => {
    const s = checksFailedScenario();
    s.script({ nodeId: "prepare" }, PREPARED_WORKSPACE_OUTPUT);
    s.script({ nodeId: "fetch-context" }, FETCH_CONTEXT_OUTPUT);
    s.script(
      { nodeId: "fix" },
      executionError("The fix sandbox crashed.", {
        category: "sandbox",
        phase: "agent",
      }),
    );

    const outcome = await s.execute();

    expect(outcome.result.outcome).toBe("failed");
    expect(outcome.result.executionError).toMatchObject({
      nodeId: "fix",
      category: "sandbox",
    });
    expectNeverInvoked(outcome, ["checks", "finalize", "comment"]);
  });
});
